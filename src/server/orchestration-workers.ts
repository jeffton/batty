import { workerTools } from "./orchestration-worker-config.js";
import { modelChange } from "./orchestration-worker-config.js";
import type { Context, JsonValue } from "@earendil-works/chord";

import { Type, type Message } from "@earendil-works/pi-ai";
import {
  AgentDoc,
  LiveDoc,
  InboxDoc,
  configure,
  defineTask,
  defineTool,
  type Agent,
  type AgentChange,
  type ConversationId,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";

import type { WorkspaceInfo } from "../shared/types.js";

import {
  buildSubagentRuntimeNotice,
  buildSubagentSteeringRuntimeNotice,
  decodeRuntimeNotice,
  encodeRuntimeNotice,
} from "./runtime-notices.js";

import { reportWithAttachments } from "./attachment-contract.js";
import { reportWithArtifacts } from "./artifact-forwarding.js";
import { runtimeResultArtifacts } from "./runtime-result-artifacts.js";

import { ArchivedWorker, DeliveryRecord } from "./orchestration-history";

import {
  OrchestrationDoc,
  WorkerDoc,
  type DeliveryInput,
  type RunChange,
  type OrchestrationServices,
} from "./orchestration-state.js";
import type { createDeliveryTask } from "./orchestration-delivery.js";

function reply(text: string) {
  return { output: [{ type: "text" as const, text }] };
}

export function createWorkers(
  services: OrchestrationServices,
  Delivery: ReturnType<typeof createDeliveryTask>,
) {
  async function captureStop(workerId: string, ctx: Context) {
    const state = (await services.harness.snapshot(OrchestrationDoc, ctx))!;
    const worker =
      state.workers[workerId] ?? (await services.harness.snapshot(ArchivedWorker, workerId, ctx));
    if (!worker) return undefined;
    const candidates = [
      ...new Set([
        ...Object.values(state.calls)
          .filter((call) => call.workerId === workerId)
          .map((call) => call.taskId),
        ...(worker.active === undefined ? [] : [worker.active]),
      ]),
    ];
    const targets: TaskId<string>[] = [];
    for (const id of candidates)
      if ((await services.harness.getTask(id, ctx))?.state.status !== "terminal") targets.push(id);
    return { targets, browserTask: worker.active === undefined ? null : String(worker.active) };
  }

  async function applyStop(
    workerId: string,
    stop: NonNullable<Awaited<ReturnType<typeof captureStop>>>,
    ctx: Context,
  ) {
    for (const target of [...stop.targets].reverse()) await services.harness.abortTask(target, ctx);
    if (stop.browserTask !== null)
      await services.browserLifecycle?.stop(workerId, stop.browserTask);
  }

  async function stopWorker(workerId: string, ctx: Context) {
    const stop = await captureStop(workerId, ctx);
    if (!stop) throw Object.assign(new Error("Unknown subagent"), { statusCode: 404 });
    await applyStop(workerId, stop, ctx);
  }

  const Anchor = defineTask<null, { phase: "done" }, null>({
    name: "batty.worker-anchor",
    version: 1,
    initial: () => ({ phase: "done" }),
    phases: {
      done: async (_, runtime, ctx) => {
        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
          ctx,
        );
      },
    },
    abort: async (_, runtime, ctx) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
    },
  });
  const createWorker = async (
    tx: Tx,
    owner: TaskId,
    parentId: ConversationId,
    ws: Pick<WorkspaceInfo, "id" | "path">,
    prompt: string,
    parentAgent: Agent,
    change: AgentChange,
    prefix: readonly Message[],
  ) => {
    const ownership = { kind: "task" as const, taskId: owner };
    const child = await tx.createConversation({ ownership });
    // Anchor ownership is concurrency metadata, not an implicit source of agent settings.
    await configure(tx, child.id, {
      model: parentAgent.model ?? null,
      thinkingLevel: parentAgent.thinkingLevel,
      extensions: parentAgent.extensions,
      instructions: parentAgent.instructions ?? null,
      ...change,
      cwd: ws.path,
    });
    (await tx.doc(AgentDoc, child.id)).tools = workerTools(
      parentAgent,
      ws.id,
      await services.assistantWorkspaceId(),
    );
    for (const message of prefix) {
      const kind =
        message.role === "system"
          ? "pi.system"
          : message.role === "assistant"
            ? "pi.assistant"
            : message.role === "user"
              ? "pi.user"
              : "pi.tool-result";
      await tx.appendEntry(child.id, {
        kind,
        model: [message],
        ...(message.role === "toolResult" ? { data: { diagnostics: [] } } : {}),
      });
    }
    const metadata = await tx.doc(WorkerDoc, child.id);
    metadata.workspaceId = ws.id;
    metadata.parentId = parentId;
    metadata.isSubagent = true;
    const state = await tx.doc(OrchestrationDoc);
    state.workers[String(child.id)] = {
      id: child.id,
      parentId,
      workspaceId: ws.id,
      prompt,
      reported: [],
    };
    return child.id;
  };
  // Joining is background assignment work, not a live model tool round. The
  // delivery owns the wait so the worker can receive steering while suspended.
  const AwaitChild = defineTask<
    { target: TaskId<string>; workerId: string; parentId: ConversationId },
    { phase: "wait" },
    null
  >({
    name: "batty.await-child",
    version: 1,
    initial: () => ({ phase: "wait" }),
    phases: {
      wait: async (task, runtime, ctx) => {
        const settled = await runtime.waitForTask(task.input.target, ctx);
        const artifacts = (await runtime.snapshot(DeliveryRecord, String(task.input.target), ctx))
          ?.artifacts;
        const text =
          `Subagent ${settled.state.outcome.status === "completed" ? "result" : settled.state.outcome.status}. Session ID: ${task.input.workerId}\n\n${
            settled.state.outcome.status === "completed"
              ? reportWithArtifacts(
                  reportWithAttachments(settled.state.outcome.result, artifacts?.sentFiles),
                  artifacts,
                )
              : ""
          }`.trimEnd();
        const parent = (await runtime.conversation(task.input.parentId, ctx))!;
        const submission = await parent.submit(
          {
            type: "input",
            content: encodeRuntimeNotice({
              kind: "subagent",
              text,
              data: {
                subagent: { sessionId: task.input.workerId },
                ...(artifacts ? { runtimeResultArtifacts: artifacts } : {}),
              },
            }),
            whenBusy: "steer",
            requestId: `batty-join:${task.id}`,
          },
          ctx,
        );
        await runtime.commit(async (tx) => {
          const completion = (await tx.doc(WorkerDoc, task.input.parentId)).completion!;
          if (!completion.inputs.includes(submission.id)) completion.inputs.push(submission.id);
          return { status: "terminal", outcome: { status: "completed", result: null } };
        }, ctx);
      },
    },
    abort: async (_, runtime, ctx) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
    },
  });
  const subagent = defineTool({
    name: "subagent",
    description:
      "Run, await, queue, resume, steer or stop subagents. Workers can report an explicit intermediate update to their actual parent with action=report and prompt, without ending their work; currently attached artifacts accompany the report. No sessionId is accepted for report. Commentary is not forwarded. Start a subagent, await it, then use its result. Start multiple async helpers before awaiting to run them in parallel. Reuse the Session ID returned by this tool for await, queue, resume, steer or stop; never guess an ID or use a memory-entry ID.",
    replay: "safe",
    parameters: Type.Object({
      action: Type.Union(
        (["run", "await", "queue", "resume", "steer", "stop", "report"] as const).map((value) =>
          Type.Literal(value),
        ),
      ),
      sessionId: Type.Optional(Type.String()),
      prompt: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      effort: Type.Optional(Type.String()),
      async: Type.Optional(Type.Boolean()),
      workspaceId: Type.Optional(Type.String()),
      includePreviousContext: Type.Optional(
        Type.Union([Type.Boolean(), Type.Literal("chat-only")]),
      ),
    }),
    execute: async (args, api, ctx) => {
      if (args.action === "report") {
        if (args.sessionId !== undefined)
          throw new Error("Report targets the actual parent; omit sessionId");
        if (!args.prompt?.trim()) throw new Error("report requires prompt");
        const metadata = await api.snapshot(WorkerDoc, api.conversationId, ctx);
        if (!metadata?.isSubagent || metadata.parentId === undefined || !metadata.completion)
          throw new Error("Only an assigned subagent can report to its parent");
        const parentId = metadata.parentId;
        // Pin both text and attachment descriptors across safe tool replay. Only
        // this assignment contributes artifacts, never an earlier resumed run.
        const content = await api.memo(
          "batty.progress-report",
          await api.commit(async (tx) => {
            const source = await tx.submissionByRequest(
              api.conversationId,
              `batty-deliver:${metadata.completion!.owner}`,
            );
            if (!source?.entry) throw new Error("Missing subagent assignment entry");
            const entries = [];
            let cursor;
            do {
              const page = await tx.scanEntries(
                { conversationId: api.conversationId, minEntryId: source.entry },
                200,
                cursor,
              );
              entries.unshift(...[...page.items].reverse());
              cursor = page.next;
            } while (cursor);
            const artifacts = runtimeResultArtifacts(entries);
            return encodeRuntimeNotice({
              kind: "subagent",
              text: `[subagent ${api.conversationId} report]\n${reportWithArtifacts(reportWithAttachments(args.prompt!, artifacts.sentFiles), artifacts)}`,
              data: {
                runtimeResultArtifacts: artifacts,
                runtimeNotice: {
                  text: `Subagent ${api.conversationId} report`,
                  markdown: args.prompt!,
                },
                subagent: { sessionId: String(api.conversationId) },
              },
            });
          }, ctx),
          ctx,
        );
        await (await api.conversation(parentId, ctx))!.submit(
          {
            type: "input",
            content,
            whenBusy: "steer",
            requestId: `batty-progress:${api.taskId}`,
          },
          ctx,
        );
        return reply(`Reported to parent. Session ID: ${api.conversationId}. Work may continue.`);
      }
      const state = await api.snapshot(OrchestrationDoc, ctx);
      const existingCall = (await api.snapshot(DeliveryRecord, String(api.taskId), ctx))?.call;
      const workerId = existingCall?.workerId ?? args.sessionId;
      const worker = workerId
        ? (state?.workers[workerId] ?? (await api.snapshot(ArchivedWorker, workerId, ctx)))
        : undefined;
      if (args.action !== "run" && !worker) throw new Error(`Unknown subagent: ${workerId}`);
      const active =
        worker?.active === undefined ? undefined : await api.getTask(worker.active, ctx);
      const running = active !== undefined && active.state.status !== "terminal";
      if (
        args.action === "await" &&
        (api.conversationId !== state!.mainId || state!.inlineContext)
      ) {
        // Only joining a direct child is acyclic. Pin the delivery across replay,
        // even when a later queue/resume changes the worker's active task.
        if (worker!.parentId !== api.conversationId)
          throw new Error("Await requires a child of this session");
        const target = await api.memo("batty.await", worker!.active!, ctx);
        const waiting = (await api.getTask(target, ctx))!.state.status !== "terminal";
        await api.commit(async (tx) => {
          const doc = await tx.doc(OrchestrationDoc);
          const report = await tx.submissionByRequest(api.conversationId, `batty-report:${target}`);
          const metadata = await tx.doc(WorkerDoc, api.conversationId);
          const completion = (metadata.completion ??= {
            owner:
              api.conversationId === doc.mainId
                ? doc.runs[doc.inlineContext!.runId]!.taskId
                : doc.workers[String(api.conversationId)]!.active!,
            inputs: [...(await tx.doc(LiveDoc, api.conversationId)).run!.inputs],
            waits: {},
          });
          let waiter = completion.waits[String(target)];
          if (waiting && waiter === undefined) {
            waiter = await tx.createTask(
              AwaitChild,
              { target, workerId: workerId!, parentId: api.conversationId },
              {
                ownership: { kind: "task", taskId: completion.owner },
              },
            );
            completion.waits[String(target)] = waiter;
          }
          (await tx.doc(DeliveryRecord, String(target), {})).join = waiter ?? api.taskId;
          const live = await tx.doc(LiveDoc, api.conversationId);
          doc.joinParents ??= {};
          // Inputs survive generation handovers; taskId changes every tool round.
          doc.joinParents[String(api.conversationId)] = live.run!.inputs[0]!;
          // Keep other parallel helpers pending until explicitly joined or this
          // parent turn finishes; steering must not replace an await continuation.
          const pending = await tx.doc(InboxDoc, api.conversationId);
          for (const item of pending.items) {
            if (item.mode !== "steer") continue;
            const notice = decodeRuntimeNotice(item.content);
            if (notice?.kind === "subagent") item.mode = "followUp";
          }
          // A faster parallel child may have queued its report before this join.
          // Withdraw it atomically before the tool round admits steering inputs.
          if (report?.status === "queued") {
            tx.settleSubmission(report.id, { status: "unanswered", reason: "aborted" });
            const inbox = await tx.doc(InboxDoc, api.conversationId);
            inbox.items = inbox.items.filter((item) => item.id !== report.id);
          }
        }, ctx);
        if (waiting)
          return {
            ...reply(`Awaiting subagent. Session ID: ${workerId}`),
            control: { terminate: true as const },
          };
        const settled = await api.waitForTask(target, ctx);
        const artifacts = (await api.snapshot(DeliveryRecord, String(target), ctx))?.artifacts;
        return {
          ...reply(
            `Subagent ${settled.state.outcome.status === "completed" ? "result" : settled.state.outcome.status}. Session ID: ${workerId}\n\n${
              settled.state.outcome.status === "completed"
                ? reportWithArtifacts(
                    reportWithAttachments(settled.state.outcome.result, artifacts?.sentFiles),
                    artifacts,
                  )
                : ""
            }`.trimEnd(),
          ),
          details: artifacts ?? {},
        };
      }
      if (args.action === "await")
        return {
          ...reply(
            running
              ? `Awaiting subagent. Session ID: ${workerId}`
              : `Subagent finished. Session ID: ${workerId}`,
          ),
          ...(running ? { control: { terminate: true as const } } : {}),
        };
      if (args.action === "stop") {
        // Capture the whole current delivery chain, not only its queued tail.
        // The memo keeps a replay from stopping later resumed work.
        const stop = await api.memo("batty.stop", (await captureStop(workerId!, ctx))!, ctx);
        await applyStop(workerId!, stop, ctx);
        return reply(`Stopped. Session ID: ${workerId}`);
      }
      if (!args.prompt?.trim()) throw new Error(`${args.action} requires prompt`);
      if (args.action === "steer") {
        if (!running) throw new Error("Cannot steer a finished subagent; use resume");
        await (await api.conversation(worker!.id, ctx))!.submit(
          {
            type: "input",
            content: encodeRuntimeNotice(buildSubagentSteeringRuntimeNotice(args.prompt)),
            whenBusy: "steer",
            requestId: `batty-steer:${api.taskId}`,
          },
          ctx,
        );
        return reply(`Steered. Session ID: ${workerId}`);
      }
      const ws = await services.workspace(
        args.workspaceId ?? worker?.workspaceId,
        api.conversationId,
      );
      const inherited = await api.agent(ctx);
      const prefix =
        args.action === "run" && !existingCall
          ? await services.preparedContext(
              api.conversationId,
              args.includePreviousContext ?? false,
              ws.id,
            )
          : [];
      const isAsync =
        api.conversationId === state!.mainId || args.action === "queue" || args.async === true;
      const change = modelChange(args.model, args.effort);
      const admit = () =>
        api.commit(async (tx) => {
          const doc = await tx.doc(OrchestrationDoc);
          const call = await tx.doc(DeliveryRecord, String(api.taskId), {});
          const prior = call.call;
          if (prior) return { ...prior };
          if (args.sessionId && !doc.workers[args.sessionId]) {
            doc.workers[args.sessionId] = {
              ...(await tx.doc(ArchivedWorker, args.sessionId, worker!)),
            };
          }
          const currentWorker = args.sessionId ? doc.workers[args.sessionId] : undefined;
          const currentTask =
            currentWorker?.active === undefined ? undefined : await tx.task(currentWorker.active);
          const currentlyRunning =
            currentTask !== undefined && currentTask.state.status !== "terminal";
          if (args.action === "resume" && currentlyRunning)
            throw new Error("Subagent is running; use queue or steer");
          if (args.action === "queue" && !currentlyRunning)
            throw new Error("Subagent is finished; use resume");
          let child = currentWorker?.id;
          if (child === undefined) {
            const owner = isAsync
              ? await tx.createTask(Anchor, null, {
                  ownership: { kind: "conversation" },
                  background: true,
                })
              : api.taskId;
            child = await createWorker(
              tx,
              owner,
              api.conversationId,
              ws,
              args.prompt!,
              inherited,
              change,
              prefix,
            );
          }
          const id = String(child);
          const input: DeliveryInput = {
            workerId: id,
            childId: child,
            mainId: doc.mainId!,
            prompt: args.prompt!,
            notice: buildSubagentRuntimeNotice(
              0,
              args.prompt!,
              args.includePreviousContext ?? false,
            ),
            report: isAsync,
            change: { ...change, cwd: ws.path } as RunChange,
            workspaceId: ws.id,
          };
          if (args.action === "queue" && currentWorker?.active !== undefined)
            input.previous = currentWorker.active;
          const taskId = await tx.createTask(
            Delivery,
            input,
            isAsync
              ? { ownership: { kind: "conversation" }, background: true }
              : { ownership: { kind: "task", taskId: api.taskId } },
          );
          doc.workers[id]!.active = taskId;
          doc.workers[id]!.startedAtMs = Date.now();
          doc.calls[String(api.taskId)] = { workerId: id, taskId };
          call.call = { workerId: id, taskId };
          return { workerId: id, taskId };
        }, ctx);
      const result =
        args.sessionId && services.browserLifecycle
          ? await services.browserLifecycle.admit(args.sessionId, admit)
          : await admit();
      await api.details(
        {
          conversationId: Number(result.workerId),
          subagent: {
            sessionId: result.workerId,
            prompt: args.prompt,
            workspaceId: ws.id,
            async: isAsync,
            respondIn: isAsync ? "session" : "tool-call",
            includePreviousContext: args.includePreviousContext ?? false,
          },
        },
        ctx,
      );
      services.harness.resume();
      if (isAsync) return reply(`Started. Session ID: ${result.workerId}`);
      const settled = await api.waitForTask(result.taskId, ctx);
      const artifacts = (await api.snapshot(DeliveryRecord, String(result.taskId), ctx))?.artifacts;
      return {
        ...reply(
          `Subagent ${settled.state.outcome.status === "completed" ? "result" : settled.state.outcome.status}. Session ID: ${result.workerId}\n\n${
            settled.state.outcome.status === "completed"
              ? reportWithArtifacts(
                  reportWithAttachments(settled.state.outcome.result, artifacts?.sentFiles),
                  artifacts,
                )
              : ""
          }`.trimEnd(),
        ),
        details: {
          conversationId: Number(result.workerId),
          subagent: {
            sessionId: result.workerId,
            prompt: args.prompt,
            workspaceId: ws.id,
            async: isAsync,
            respondIn: "tool-call",
            includePreviousContext: args.includePreviousContext ?? false,
          },
          ...artifacts,
        } as unknown as Record<string, JsonValue>,
      };
    },
  });

  return {
    Anchor,
    AwaitChild,
    createWorker,
    subagent,
    stopWorker,
    async canStopWorker(workerId: string, ctx: Context) {
      const stop = await captureStop(workerId, ctx);
      return stop !== undefined && stop.targets.length > 0;
    },
  };
}
