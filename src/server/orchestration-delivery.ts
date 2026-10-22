import { archiveWorker, removeCompletedOneShot } from "./orchestration-lifecycle.js";
import type { JsonValue } from "@earendil-works/chord";

import {
  AssistantEntry,
  AgentDoc,
  LiveDoc,
  InboxDoc,
  configure,
  defineTask,
  type SubmissionId,
  type SettledSubmissionRecord,
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
    }),
    ...(marker ? { data: { cron: JSON.parse(marker[1]!) } } : {}),
  };
}

function submissionEnd(submission: SettledSubmissionRecord) {
  return submission.status === "done" && submission.type === "input"
    ? submission.answer
    : (submission.entry ?? 0);
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
        if (
          task.state.checkpoint.retryAt !== undefined &&
          task.state.checkpoint.retryAt > runtime.now()
        ) {
          await runtime.sleepUntil(task.state.checkpoint.retryAt, task.state.checkpoint, ctx);
          return;
        }
        let submissionId: SubmissionId | undefined;
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
          const metadata = await tx.doc(WorkerDoc, task.input.childId);
          metadata.completion ??= {
            owner: task.id,
            inputs: existing ? [existing.id] : [],
            waits: {},
          };
          if (!existing && task.input.change) {
            await configure(tx, task.input.childId, task.input.change);
            if (task.input.workspaceId) {
              if (metadata.workspaceId !== task.input.workspaceId) {
                delete metadata.latestReport;
                delete metadata.latestResultAssignment;
              }
              (await tx.doc(OrchestrationDoc)).workers[task.input.workerId]!.workspaceId =
                task.input.workspaceId;
              (await tx.doc(WorkerDoc, task.input.childId)).workspaceId = task.input.workspaceId;
              (await tx.doc(AgentDoc, task.input.childId)).tools = workerTools(
                childAgent,
                task.input.workspaceId,
                await services.assistantWorkspaceId(),
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
        const original = await (await services.harness.submission(submissionId, ctx))!.wait(ctx);
        let settled = original;
        // An await tool ends only the model turn, not this assignment. Join
        // receipts and every admitted continuation must settle before reporting.
        // These waits belong to Delivery, leaving the conversation steerable.
        const completion = (await runtime.snapshot(WorkerDoc, task.input.childId, ctx))!
          .completion!;
        for (const wait of Object.values(completion.waits)) await runtime.waitForTask(wait, ctx);
        for (const id of completion.inputs) {
          const candidate = await (await services.harness.submission(id, ctx))!.wait(ctx);
          // Registration can race steering admission. Transcript order, not
          // bookkeeping insertion order, identifies the final answer.
          if (submissionEnd(candidate) >= submissionEnd(settled)) settled = candidate;
        }
        let artifacts: AgentTurnArtifacts | undefined;
        if (settled.status === "done" && settled.type === "input") {
          const child = (await services.harness.conversation(task.input.childId, ctx))!;
          const entries = [];
          let cursor;
          do {
            const page = await child.entries(
              { minEntryId: original.entry, maxEntryId: settled.answer },
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
          const metadata = await tx.doc(WorkerDoc, task.input.childId);
          const live = await tx.doc(LiveDoc, task.input.childId);
          // Admission and assignment completion share the mutation line. A
          // final boundary can start a queued steering run before its first
          // request hook executes; register those inputs here as well.
          for (const id of live.run?.inputs ?? [])
            if (!metadata.completion!.inputs.includes(id)) metadata.completion!.inputs.push(id);
          if (live.run || JSON.stringify(metadata.completion) !== JSON.stringify(completion))
            return {
              status: "running",
              checkpoint: { phase: "deliver", retryAt: runtime.now() + 1 },
            };
          delete metadata.completion;
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
            const run = doc.runs[task.input.runId]!;
            run.status = failed ? "failed" : "completed";
            run.finishedAt = runtime.now();
            run.output = text;
            removeCompletedOneShot(doc.jobs, run);
            Object.assign(await tx.doc(ArchivedRun, run.id, run), run);
            delete doc.runs[run.id];
          }
          const metadata = await tx.doc(WorkerDoc, task.input.childId);
          metadata.latestResultAssignment = task.id;
          if (metadata.completion?.owner === task.id) delete metadata.completion;
          const doc = await tx.doc(OrchestrationDoc);
          if (doc.joinParents) delete doc.joinParents[String(task.input.childId)];
          await archiveWorker(tx, task.input.workerId, task.id);
          if (task.input.remoteAssignment) {
            await tx.appendEntry(task.input.childId, {
              kind: "batty.remote-result",
              data: {
                assignment: task.input.remoteAssignment,
                assignmentId: String(task.id),
                text,
                failed,
                ...(artifacts
                  ? { artifacts: artifacts as AgentTurnArtifacts & Record<string, JsonValue> }
                  : {}),
              },
            });
          }
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
      if (record) {
        const live = await runtime.snapshot(LiveDoc, task.input.childId, ctx);
        const completion = (await runtime.snapshot(WorkerDoc, task.input.childId, ctx))?.completion;
        if (live?.run && (completion?.owner === task.id || live.run.inputs.includes(record.id))) {
          await services.harness.abortTask(live.run.taskId, ctx);
          await services.harness.waitForTask(live.run.taskId, ctx);
        }
      }
      await runtime.commit(async (tx) => {
        if (task.input.runId) {
          const doc = await tx.doc(OrchestrationDoc);
          const run = doc.runs[task.input.runId]!;
          run.status = "aborted";
          run.finishedAt = runtime.now();
          Object.assign(await tx.doc(ArchivedRun, run.id, run), run);
          delete doc.runs[run.id];
        }
        const metadata = await tx.doc(WorkerDoc, task.input.childId);
        if (metadata.completion?.owner === task.id) delete metadata.completion;
        const doc = await tx.doc(OrchestrationDoc);
        if (doc.joinParents) delete doc.joinParents[String(task.input.childId)];
        await archiveWorker(tx, task.input.workerId, task.id);
        if (task.input.remoteAssignment)
          await tx.appendEntry(task.input.childId, {
            kind: "batty.remote-result",
            data: {
              assignment: task.input.remoteAssignment,
              assignmentId: String(task.id),
              text: "Stopped.",
              failed: true,
            },
          });
        return { status: "terminal", outcome: { status: "aborted", result: "Stopped." } };
      }, ctx);
    },
  });
  return Delivery;
}
