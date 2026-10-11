import {
  restoreInlineAgent,
  archiveWorker,
  removeCompletedOneShot,
} from "./orchestration-lifecycle.js";
import type { JsonValue } from "@earendil-works/chord";

import {
  AssistantEntry,
  AgentDoc,
  LiveDoc,
  InboxDoc,
  GenerationTask,
  configure,
  defineTask,
  type AgentChange,
  type AgentState,
  type SubmissionId,
} from "@earendil-works/pi-durable";

import { NO_REPLY_SENTINEL } from "../shared/agent-notification.js";

import {
  buildCronRuntimeNotice,
  buildSubagentRuntimeNotice,
  encodeRuntimeNotice,
  type RuntimeNotice,
} from "./runtime-notices.js";

import { runtimeResultArtifacts } from "./runtime-result-artifacts.js";
import { reportWithAttachments } from "./attachment-contract.js";
import { reportWithArtifacts } from "./artifact-forwarding.js";
import type { AgentTurnArtifacts } from "./agent-turn-file-changes.js";

import { ArchivedRun, DeliveryRecord } from "./orchestration-history";

import {
  OrchestrationDoc,
  WorkerDoc,
  type DeliveryInput,
  type OrchestrationServices,
} from "./orchestration-state.js";

import { workerTools } from "./orchestration-worker-config.js";

// Deliveries admitted before runtime notices retain their original assignment.
function deliveryNotice(input: DeliveryInput): RuntimeNotice {
  if (input.notice) return input.notice;
  if (!input.runId) return buildSubagentRuntimeNotice(0, input.prompt);
  const marker = /^<batty-cron-context>(.*?)<\/batty-cron-context>\n/s.exec(input.prompt);
  return {
    ...buildCronRuntimeNotice({
      scheduleLabel: "persisted scheduled run",
      prompt: marker ? input.prompt.slice(marker[0].length) : input.prompt,
      session: { kind: input.inline ? "main-inline" : "main-detached" },
    }),
    ...(marker ? { data: { cron: JSON.parse(marker[1]!) } } : {}),
  };
}

type DeliveryState =
  | { phase: "order" }
  | { phase: "deliver"; retryAt?: number }
  | {
      phase: "report";
      text: string;
      send: boolean;
      failed: boolean;
      artifacts?: AgentTurnArtifacts;
    };

export function createDeliveryTask(services: OrchestrationServices) {
  const Delivery = defineTask<DeliveryInput, DeliveryState, string>({
    name: "batty.delivery",
    version: 1,
    initial: () => ({ phase: "order" }),
    phases: {
      order: async (task, runtime, ctx) => {
        await runtime.commit(
          () =>
            task.input.previous === undefined
              ? { status: "running", checkpoint: { phase: "deliver" } }
              : {
                  status: "waiting",
                  checkpoint: { phase: "deliver" },
                  on: [task.input.previous],
                  policy: "allSettled",
                },
          ctx,
        );
      },
      deliver: async (task, runtime, ctx) => {
        if (task.state.checkpoint.retryAt !== undefined)
          await runtime.sleep(task.state.checkpoint.retryAt, ctx);
        let submissionId: SubmissionId | undefined;
        let wakeRequest: string | undefined;
        if (task.input.inline) {
          let prepared: AgentChange = {};
          let preparedFrom: AgentState | undefined;
          if (services.prepareAgent) {
            const live = await runtime.snapshot(LiveDoc, task.input.childId, ctx);
            const inbox = await runtime.snapshot(InboxDoc, task.input.childId, ctx);
            const state = await runtime.snapshot(OrchestrationDoc, ctx);
            if (!live?.run && !inbox?.items.length && !state?.inlineContext) {
              preparedFrom = await runtime.snapshot(AgentDoc, task.input.childId, ctx);
              const agent = await services.main.agent(ctx);
              prepared = await services.prepareAgent(
                task.input.change?.cwd ?? agent.cwd!,
                agent,
                ctx,
              );
            }
          }
          await runtime.commit(async (tx) => {
            const existing = await tx.submissionByRequest(
              task.input.childId,
              `batty-deliver:${task.id}`,
            );
            if (existing) {
              submissionId = existing.id;
              return;
            }
            const live = await tx.doc(LiveDoc, task.input.childId);
            const inbox = await tx.doc(InboxDoc, task.input.childId);
            const doc = await tx.doc(OrchestrationDoc);
            if (live.run || inbox.items.length || doc.inlineContext) {
              // A failed main run can leave an idle inbox. A passive submission
              // wakes its normal boundary without bypassing older user inputs.
              if (!live.run && inbox.items.length && !doc.inlineContext)
                wakeRequest = `batty-inline-wake:${task.id}:${inbox.items[0]!.id}`;
              return {
                status: "running",
                checkpoint: { phase: "deliver", retryAt: runtime.now() + 50 },
              };
            }
            const storedAgent = await tx.doc(AgentDoc, task.input.childId);
            if (
              services.prepareAgent &&
              (preparedFrom === undefined ||
                JSON.stringify(storedAgent) !== JSON.stringify(preparedFrom))
            )
              return {
                status: "running",
                checkpoint: { phase: "deliver", retryAt: runtime.now() + 50 },
              };
            doc.inlineContext = {
              cwd: storedAgent.cwd ?? null,
              model: storedAgent.model ?? null,
              thinkingLevel: storedAgent.thinkingLevel ?? "off",
              runId: task.input.runId!,
              selection: {
                extensions: storedAgent.extensions ?? null,
                tools: storedAgent.tools ?? null,
              },
            };
            await configure(tx, task.input.childId, { ...task.input.change, ...prepared });
            // Atomic idle-only admission keeps scoped settings out of unrelated main turns.
            const entry = await tx.appendEntry(task.input.childId, {
              kind: "pi.user",
              model: [
                {
                  role: "user",
                  content: encodeRuntimeNotice(deliveryNotice(task.input)),
                  timestamp: runtime.now(),
                },
              ],
            });
            const submission = await tx.createSubmission({
              conversationId: task.input.childId,
              type: "input",
              status: "placed",
              entry: entry.id,
              requestId: `batty-deliver:${task.id}`,
            });
            const generation = await tx.createTask(
              GenerationTask,
              {},
              { ownership: { kind: "conversation" }, conversationId: task.input.childId },
            );
            live.run = { taskId: generation, inputs: [submission.id] };
            submissionId = submission.id;
          }, ctx);
          if (submissionId === undefined) {
            if (wakeRequest)
              await services.main.submit(
                { type: "write", entry: { kind: "batty.cron-wake" }, requestId: wakeRequest },
                ctx,
              );
            return;
          }
        } else {
          let admitted = false;
          const childAgent = await (await services.harness.conversation(
            task.input.childId,
            ctx,
          ))!.agent(ctx);
          await runtime.commit(async (tx) => {
            const existing = await tx.submissionByRequest(
              task.input.childId,
              `batty-deliver:${task.id}`,
            );
            admitted = existing !== undefined;
            if (!existing && task.input.change) {
              await configure(tx, task.input.childId, task.input.change);
              if (task.input.workspaceId) {
                (await tx.doc(OrchestrationDoc)).workers[task.input.workerId]!.workspaceId =
                  task.input.workspaceId;
                (await tx.doc(WorkerDoc, task.input.childId)).workspaceId = task.input.workspaceId;
                (await tx.doc(AgentDoc, task.input.childId)).tools = workerTools(
                  childAgent,
                  task.input.workspaceId,
                );
              }
            }
          }, ctx);
          if (services.prepareAgent && !admitted) {
            const child = (await services.harness.conversation(task.input.childId, ctx))!;
            const agent = await child.agent(ctx);
            const prepared = await services.prepareAgent(agent.cwd!, agent, ctx);
            await runtime.commit(async (tx) => {
              const existing = await tx.submissionByRequest(
                task.input.childId,
                `batty-deliver:${task.id}`,
              );
              if (!existing) await configure(tx, task.input.childId, prepared);
            }, ctx);
          }
          const child = (await runtime.conversation(task.input.childId, ctx))!;
          submissionId = (
            await child.submit(
              {
                type: "input",
                content: encodeRuntimeNotice(deliveryNotice(task.input)),
                requestId: `batty-deliver:${task.id}`,
                whenBusy: "followUp",
              },
              ctx,
            )
          ).id;
        }
        const settled = await (await services.harness.submission(submissionId, ctx))!.wait(ctx);
        let artifacts: AgentTurnArtifacts | undefined;
        if (settled.status === "done" && settled.type === "input") {
          const child = (await services.harness.conversation(task.input.childId, ctx))!;
          const entries = [];
          let cursor;
          do {
            const page = await child.entries(
              { minEntryId: settled.entry, maxEntryId: settled.answer },
              200,
              cursor,
              ctx,
            );
            entries.unshift(...[...page.items].reverse());
            cursor = page.next;
          } while (cursor);
          artifacts = runtimeResultArtifacts(entries);
        }
        await runtime.commit(async (tx) => {
          const state = await tx.doc(OrchestrationDoc);
          const worker = state.workers[task.input.workerId];
          let text: string;
          let send = task.input.report;
          const failed = settled.status === "unanswered";
          if (settled.status === "done" && settled.type === "input") {
            const entry = await tx.entry(AssistantEntry, settled.answer);
            const message = entry?.model?.[0];
            text =
              message?.role === "assistant"
                ? message.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("")
                : "";
            if (task.input.report) {
              send = !worker!.reported.includes(settled.answer);
              if (send) worker!.reported.push(settled.answer);
            }
          } else
            text = `Task ${task.input.workerId} failed: ${settled.status === "unanswered" ? settled.reason : settled.status}`;
          return {
            status: "running",
            checkpoint: {
              phase: "report",
              text: text || "(no output)",
              send,
              failed,
              ...(artifacts ? { artifacts } : {}),
            },
          };
        }, ctx);
      },
      report: async (task, runtime, ctx) => {
        const { text, send, failed, artifacts } = task.state.checkpoint;
        const state = await runtime.snapshot(OrchestrationDoc, ctx);
        // Suppress only successful cron reports, before creating any main input or notice.
        // Keep the task result and run history intact, including for already-checkpointed reports.
        const silentCron = task.input.runId && !failed && text.trim() === NO_REPLY_SENTINEL;
        if (
          send &&
          !silentCron &&
          !(await runtime.snapshot(DeliveryRecord, String(task.id), ctx))?.join
        ) {
          const targetId = task.input.runId
            ? task.input.mainId
            : state!.workers[task.input.workerId]!.parentId;
          const target = (await runtime.conversation(targetId, ctx))!;
          const content = encodeRuntimeNotice({
            kind: task.input.runId ? "cron" : "subagent",
            text: `[${task.input.runId ? "cron" : "subagent"} ${task.input.workerId} result]\n${reportWithArtifacts(reportWithAttachments(text, artifacts?.sentFiles), artifacts)}`,
            data: {
              ...(artifacts ? { runtimeResultArtifacts: artifacts } : {}),
              runtimeNotice: {
                text: `${task.input.runId ? "Cron" : "Subagent"} ${task.input.workerId} result`,
                markdown: text,
              },
              [task.input.runId ? "cron" : "subagent"]: {
                sessionId: task.input.workerId,
                prompt: task.input.prompt,
                ...(task.input.runId ? { runId: task.input.runId } : {}),
              },
            },
          });
          const requestId = `batty-report:${task.id}`;
          // Helpers completing during a parent tool round must arbitrate report
          // admission with join registration on the same transaction line.
          let handled = false;
          if (!task.input.runId) {
            await runtime.commit(async (tx) => {
              const doc = await tx.doc(OrchestrationDoc);
              if ((await tx.doc(DeliveryRecord, String(task.id), {})).join !== undefined) {
                handled = true;
                return;
              }
              const existing = await tx.submissionByRequest(targetId, requestId);
              if (existing) {
                handled = true;
                return;
              }
              const live = await tx.doc(LiveDoc, targetId);
              if (!live.run) return;
              const submission = await tx.createSubmission({
                conversationId: targetId,
                type: "input",
                status: "queued",
                requestId,
              });
              (await tx.doc(InboxDoc, targetId)).items.push({
                id: submission.id,
                mode:
                  doc.joinParents?.[String(targetId)] === live.run.inputs[0] ? "followUp" : "steer",
                content,
              });
              handled = true;
            }, ctx);
          }
          if (task.input.runId && task.input.delivery === "direct" && !failed) {
            // Append without submit: even passive submissions wake a busy conversation.
            // The receipt and entry commit together, making retries duplicate-free.
            await runtime.commit(async (tx) => {
              const receipt = await tx.doc(DeliveryRecord, String(task.id), {});
              if (receipt.directDelivered) return;
              await tx.appendEntry(targetId, {
                kind: "batty.cron-result",
                model: [
                  {
                    // Do not split an unfinished assistant tool-result group.
                    role: "user",
                    content: encodeRuntimeNotice({
                      kind: "cron",
                      text: `[cron ${task.input.workerId} completed output]\n${reportWithArtifacts(text, artifacts)}`,
                      data: {
                        directDelivery: { text },
                        ...(artifacts ? { runtimeResultArtifacts: artifacts } : {}),
                        cron: { sessionId: task.input.workerId, runId: task.input.runId! },
                      },
                    }),
                    timestamp: runtime.now(),
                  },
                ],
                data: { cron: { sessionId: task.input.workerId, runId: task.input.runId! } },
              });
              receipt.directDelivered = true;
            }, ctx);
            handled = true;
          }
          if (!handled) {
            const submission = await target.submit(
              {
                type: "input",
                content,
                // Cron finals wait for the next main turn; subagent results
                // steer their parent. Idle recipients start a regular turn.
                whenBusy: task.input.runId ? "followUp" : "steer",
                requestId,
              },
              ctx,
            );
            // An idle parent can become busy between the commit and submit.
            // A joined parent is still held in its tool round until this task ends.
            if (
              !task.input.runId &&
              (await runtime.snapshot(DeliveryRecord, String(task.id), ctx))?.join !== undefined
            )
              await submission.abort(ctx);
          }
        }
        await runtime.commit(async (tx) => {
          if (artifacts) {
            (await tx.doc(DeliveryRecord, String(task.id), {})).artifacts =
              artifacts as AgentTurnArtifacts & Record<string, JsonValue>;
          }
          if (task.input.runId) {
            const doc = await tx.doc(OrchestrationDoc);
            if (doc.inlineContext?.runId === task.input.runId) {
              await restoreInlineAgent(tx, task.input.mainId, doc.inlineContext);
              delete doc.inlineContext;
            }
            const run = doc.runs[task.input.runId]!;
            run.status = failed ? "failed" : "completed";
            run.finishedAt = runtime.now();
            run.output = text;
            removeCompletedOneShot(doc.jobs, run);
            Object.assign(await tx.doc(ArchivedRun, run.id, run), run);
            delete doc.runs[run.id];
          }
          await archiveWorker(tx, task.input.workerId, task.id);
          return { status: "terminal", outcome: { status: "completed", result: text } };
        }, ctx);
      },
    },
    abort: async (task, runtime, ctx) => {
      const record = await services.harness.commit(
        (tx) => tx.submissionByRequest(task.input.childId, `batty-deliver:${task.id}`),
        ctx,
      );
      if (record && record.status === "queued")
        await (await services.harness.submission(record.id, ctx))!.abort(ctx);
      if (record && record.status === "placed") {
        const live = await runtime.snapshot(LiveDoc, task.input.childId, ctx);
        if (live?.run?.inputs.includes(record.id)) {
          await services.harness.abortTask(live.run.taskId, ctx);
          await services.harness.waitForTask(live.run.taskId, ctx);
        }
      }
      await runtime.commit(async (tx) => {
        if (task.input.runId) {
          const doc = await tx.doc(OrchestrationDoc);
          if (doc.inlineContext?.runId === task.input.runId) {
            await restoreInlineAgent(tx, task.input.mainId, doc.inlineContext);
            delete doc.inlineContext;
          }
          const run = doc.runs[task.input.runId]!;
          run.status = "aborted";
          run.finishedAt = runtime.now();
          Object.assign(await tx.doc(ArchivedRun, run.id, run), run);
          delete doc.runs[run.id];
        }
        await archiveWorker(tx, task.input.workerId, task.id);
        return { status: "terminal", outcome: { status: "aborted", result: "Stopped." } };
      }, ctx);
    },
  });
  return Delivery;
}
