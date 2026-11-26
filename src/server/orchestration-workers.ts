import {
  encodeWorkerNotice,
  snapshotWorkerFiles,
  type WorkerFileSource,
  type WorkerInputFile,
} from "./worker-files.js";
import { workerTools } from "./orchestration-worker-config.js";
import { modelChange } from "./orchestration-worker-config.js";
import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";

import { Type } from "typebox";
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
  type Cursor,
  type TaskId,
  type Tx,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";

import type { WorkspaceInfo } from "../shared/types.js";

import {
  buildSubagentRuntimeNotice,
  buildSubagentSteeringRuntimeNotice,
  decodeRuntimeNotice,
  encodeRuntimeNotice,
} from "./runtime-notices.js";

import { describePresentation, type AttachmentSelection } from "./message-presentation.js";

import { ArchivedWorker, DeliveryRecord } from "./orchestration-history";

import {
  OrchestrationDoc,
  WorkerDoc,
  type DeliveryInput,
  type RunChange,
  type OrchestrationServices,
} from "./orchestration-state.js";
import type { createDeliveryTask } from "./orchestration-delivery.js";

export type WorkerCommand = AttachmentSelection & {
  action:
    | "run"
    | "await"
    | "queue"
    | "resume"
    | "steer"
    | "stop"
    | "report"
    | "list"
    | "inspect"
    | "workspaces";
  nodeId?: string;
  sessionId?: string;
  limit?: number;
  cursor?: string;
  status?: "running" | "all";
  prompt?: string;
  model?: string;
  effort?: string;
  workspaceId?: string;
  files?: WorkerFileSource[];
};

/** The same lifecycle service is called by model tools and authenticated node commands. */
export type WorkerCommandContext = Pick<
  ToolExecutionApi,
  | "taskId"
  | "conversationId"
  | "agent"
  | "snapshot"
  | "commit"
  | "memo"
  | "getTask"
  | "waitForTask"
  | "conversation"
  | "details"
> & {
  remoteAssignment?: { grantId: string; requestId: string };
  inputFiles?: WorkerInputFile[];
};

function missingWorker(id: string) {
  return Object.assign(
    new Error(`Subagent session ${id} not found. Start a new subagent instead.`),
    { statusCode: 404 },
  );
}

function reply(text: string) {
  return { output: [{ type: "text" as const, text }] };
}

export function createWorkers(
  services: OrchestrationServices,
  Delivery: ReturnType<typeof createDeliveryTask>,
) {
  // Tool-level coordination only: these rules are not an OS security boundary.
  async function workerScope(tx: Tx, id: ConversationId, mainId: ConversationId) {
    while (id !== mainId) {
      if (!(await tx.conversation(id))) return false;
      const metadata = await tx.doc(WorkerDoc, id);
      if (metadata.isCron) return true;
      if (!metadata.isSubagent || metadata.parentId === undefined) return false;
      id = metadata.parentId;
    }
    return true;
  }

  async function coordinationScope(tx: Tx, callerId: ConversationId) {
    const state = await tx.doc(OrchestrationDoc);
    const scope = await workerScope(tx, callerId, state.mainId!);
    if (!scope) throw new Error("Subagent tools require main or an assigned worker");
    return {
      visible: (candidate: { id: ConversationId }) => workerScope(tx, candidate.id, state.mainId!),
    };
  }

  async function captureStop(workerId: string, ctx: Context) {
    if (!(await services.harness.conversation(Number(workerId) as ConversationId, ctx)))
      return undefined;
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
    return { targets };
  }

  async function applyStop(
    stop: NonNullable<Awaited<ReturnType<typeof captureStop>>>,
    ctx: Context,
    waitForCompletion = true,
  ) {
    for (const target of [...stop.targets].reverse()) await services.harness.abortTask(target, ctx);
    if (waitForCompletion)
      for (const target of stop.targets) await services.harness.waitForTask(target, ctx);
  }

  async function stopWorker(workerId: string, ctx: Context) {
    const stop = await captureStop(workerId, ctx);
    if (!stop) throw missingWorker(workerId);
    await applyStop(stop, ctx);
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
    (await tx.doc(AgentDoc, child.id)).tools = workerTools(parentAgent);
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
        const presentation = (
          await runtime.snapshot(DeliveryRecord, String(task.input.target), ctx)
        )?.presentation;
        const text =
          `Subagent ${settled.state.outcome.status === "completed" ? "result" : settled.state.outcome.status}. Session ID: ${task.input.workerId}\n\n${
            typeof settled.state.outcome.result === "string"
              ? describePresentation(settled.state.outcome.result, presentation)
              : ""
          }`.trimEnd();
        const parent = (await runtime.conversation(task.input.parentId, ctx))!;
        await runtime.commit(async (tx) => {
          // A repeated await may already have returned the completed result.
          // Arbitrate that receipt and notification admission on the same line.
          const receipt = await tx.doc(DeliveryRecord, String(task.input.target), {});
          const completion = (await tx.doc(WorkerDoc, task.input.parentId)).completion;
          if (
            !receipt.joinConsumed &&
            completion &&
            !completion.retiring &&
            completion.waits[String(task.input.target)] === task.id
          ) {
            const submission = await parent.submit(tx, {
              type: "input",
              content: encodeRuntimeNotice({
                kind: "subagent",
                text,
                data: {
                  subagent: { sessionId: task.input.workerId },
                  ...(presentation ? { runtimePresentation: presentation } : {}),
                },
              }),
              whenBusy: "steer",
              requestId: `batty-join:${task.id}`,
            });
            if (!completion.inputs.includes(submission)) completion.inputs.push(submission);
          }
          return { status: "terminal", outcome: { status: "completed", result: null } };
        }, ctx);
      },
    },
    abort: async (_, runtime, ctx) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
    },
  });
  const queryWorkers = async (
    args: WorkerCommand,
    api: Pick<WorkerCommandContext, "conversationId" | "snapshot" | "commit" | "remoteAssignment">,
    ctx: Context,
  ) => {
    const state = await api.snapshot(OrchestrationDoc, ctx);
    if (args.action === "inspect" && !args.sessionId) throw new Error("inspect requires sessionId");
    const cursor = args.cursor ? (JSON.parse(args.cursor) as Cursor) : undefined;
    const history = args.status === "all";
    const page =
      args.action === "list" && history
        ? await api.commit(
            (tx) => tx.scanConversations({ order: "descending" }, args.limit ?? 50, cursor),
            ctx,
          )
        : undefined;
    const ids =
      args.action !== "list"
        ? [args.sessionId!]
        : page
          ? page.items.map((item) => String(item.id))
          : Object.keys(state?.workers ?? {})
              .filter((id) => cursor?.after === undefined || Number(id) < Number(cursor.after))
              .sort((a, b) => Number(b) - Number(a));
    // Preload only archive seeds outside the transaction. Authorization,
    // workspace and output pointers are read together under the mutation line.
    const seeds = new Map<string, NonNullable<typeof state>["workers"][string]>();
    for (const id of ids) {
      const candidate = state?.workers[id] ?? (await api.snapshot(ArchivedWorker, id, ctx));
      if (candidate) seeds.set(id, candidate);
    }
    const local = await api.commit(async (tx) => {
      const state = await tx.doc(OrchestrationDoc);
      const findWorker = async (id: string) => {
        if (!(await tx.conversation(Number(id) as ConversationId))) return undefined;
        const seed = seeds.get(id);
        return state.workers[id] ?? (seed ? await tx.doc(ArchivedWorker, id, seed) : undefined);
      };
      const { visible } = await coordinationScope(tx, api.conversationId);
      const summary = async (candidate: NonNullable<typeof state>["workers"][string]) => {
        const task = candidate.active === undefined ? undefined : await tx.task(candidate.active);
        return {
          sessionId: String(candidate.id),
          workspaceId: candidate.workspaceId,
          parentId: String(candidate.parentId),
          ...(candidate.active === undefined ? {} : { assignmentId: String(candidate.active) }),
          status:
            task?.state.status === "terminal"
              ? task.state.outcome.status
              : task
                ? "running"
                : "idle",
          ...(candidate.startedAtMs === undefined ? {} : { startedAtMs: candidate.startedAtMs }),
          ...(task?.state.status === "terminal"
            ? {
                terminalCursor: String(
                  (await tx.scanEntries({ conversationId: candidate.id }, 1)).items[0]?.id ?? 0,
                ),
              }
            : {}),
        };
      };
      if (args.action === "list") {
        const workers = [];
        for (const id of ids) {
          const candidate = await findWorker(id);
          if (
            !candidate ||
            (args.workspaceId !== undefined && candidate.workspaceId !== args.workspaceId) ||
            !(await visible(candidate))
          )
            continue;
          const item = await summary(candidate);
          if (history || item.status === "running") workers.push(item);
          if (!history && workers.length > (args.limit ?? 50)) break;
        }
        const limit = args.limit ?? 50;
        const next = history
          ? page?.next
          : workers.length > limit
            ? { after: Number(workers[limit - 1]!.sessionId), order: "descending" }
            : undefined;
        return reply(
          JSON.stringify({
            workers: workers.slice(0, limit),
            ...(next ? { nextCursor: JSON.stringify(next) } : {}),
          }),
        );
      }
      if (!args.sessionId) throw new Error("inspect requires sessionId");
      const candidate = await findWorker(args.sessionId);
      if (!candidate) throw missingWorker(args.sessionId);
      if (!(await visible(candidate))) throw new Error("Unknown or inaccessible subagent");
      const status = await summary(candidate);
      const task = candidate.active === undefined ? undefined : await tx.task(candidate.active);
      const metadata = (await tx.doc(WorkerDoc, candidate.id))!;
      const latest = metadata.latestReport;
      const resultAssignment =
        metadata.latestResultAssignment ??
        (task?.state.status === "terminal" &&
        (task.state.outcome.status === "completed" || task.state.outcome.status === "failed")
          ? candidate.active
          : undefined);
      const completed =
        resultAssignment === undefined ? undefined : await tx.task(resultAssignment);
      const result =
        completed?.state.status === "terminal" &&
        typeof completed.state.outcome.result === "string" &&
        (!latest || Number(resultAssignment) >= Number(latest.assignmentId))
          ? {
              kind: "result",
              assignmentId: String(resultAssignment),
              text: completed.state.outcome.result as string,
              presentation:
                (await tx.doc(DeliveryRecord, String(resultAssignment), {})).presentation ?? {},
            }
          : latest
            ? {
                kind: "report",
                assignmentId: String(latest.assignmentId),
                text: latest.text,
                presentation: latest.presentation,
              }
            : undefined;
      // Inspection discovers references; it does not produce attachment effects.
      return {
        ...reply(
          JSON.stringify({
            ...status,
            ...(task?.state.status === "terminal" && task.state.outcome.status === "faulted"
              ? { error: task.state.outcome.error.message }
              : {}),
            ...(result
              ? {
                  latest: {
                    kind: result.kind,
                    assignmentId: result.assignmentId,
                    text: api.remoteAssignment
                      ? result.text.slice(0, 16_000)
                      : describePresentation(result.text.slice(0, 16_000), result.presentation),
                    truncated: result.text.length > 16_000,
                  },
                }
              : {}),
          }),
        ),
        details: result
          ? {
              presentation: JSON.parse(JSON.stringify(result.presentation ?? {})) as JsonValue,
            }
          : {},
      };
    }, ctx);
    return local;
  };
  const workerTool = {
    name: "subagent",
    description: [
      "Run, await, queue, resume, steer, or stop workers. Start independent workers before awaiting them. Reuse the returned sessionId; workers can await only direct children.",
      "workspaces discovers local and remote workspaces, models, and defaults. Use nodeId to start remotely. inspect reads the latest report or result without joining.",
      "Send input files on run, queue, resume, or steer as files: [{path: '…'}] or [{ref: 'file:…'}]. Limit: 32 files, 100 MiB total.",
      "Workers use report with prompt to update their parent without ending the assignment. Ordinary commentary stays local.",
    ].join(" "),
    replay: "safe" as const,
    parameters: Type.Object({
      action: Type.Union(
        (
          [
            "run",
            "await",
            "queue",
            "resume",
            "steer",
            "stop",
            "report",
            "list",
            "inspect",
            "workspaces",
          ] as const
        ).map((value) => Type.Literal(value)),
      ),
      nodeId: Type.Optional(
        Type.String({
          description:
            "Remote installation ID. Use workspaces to discover configured nodes, workspaces and models. Omit for local execution; remote session IDs already identify the node.",
        }),
      ),
      sessionId: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      cursor: Type.Optional(Type.String()),
      status: Type.Optional(
        Type.Union([Type.Literal("running"), Type.Literal("all")], {
          description:
            "list defaults to running workers; all includes paginated history, newest first.",
        }),
      ),
      files: Type.Optional(
        Type.Array(
          Type.Union([
            Type.Object({ path: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
            Type.Object({ ref: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
          ]),
          { minItems: 1, maxItems: 32 },
        ),
      ),
      artifactRefs: Type.Optional(Type.Array(Type.String())),
      browserId: Type.Optional(Type.String()),
      prompt: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      effort: Type.Optional(Type.String()),
      workspaceId: Type.Optional(Type.String()),
    }),
    execute: async (args: WorkerCommand, api: WorkerCommandContext, ctx: Context) => {
      if (
        (args.artifactRefs !== undefined || args.browserId !== undefined) &&
        args.action !== "report"
      )
        throw new Error("artifactRefs and browserId are supported only on report");
      if (args.files !== undefined && !["run", "queue", "resume", "steer"].includes(args.action))
        throw new Error("files are supported only on run, queue, resume and steer");
      await api.commit(async (tx) => {
        await coordinationScope(tx, api.conversationId);
      }, ctx);
      if (args.action === "workspaces") {
        if (!services.remoteWorkers) return reply("[]");
        return reply(JSON.stringify(await services.remoteWorkers.workspaces(args.nodeId)));
      }
      if (args.nodeId || args.sessionId?.startsWith("remote:")) {
        if (api.remoteAssignment) throw new Error("Node commands cannot re-export remote workers");
        if (!services.remoteWorkers) throw new Error("Remote instances are not configured");
        return services.remoteWorkers.command(args, api, ctx);
      }
      if (args.action === "run" && args.sessionId !== undefined)
        throw new Error(
          "run creates a new subagent; omit sessionId. Use queue or resume for an existing session",
        );
      if (["await", "queue", "resume", "steer", "stop"].includes(args.action) && !args.sessionId)
        throw new Error(`${args.action} requires sessionId`);
      if (args.action === "report") {
        if (args.sessionId !== undefined)
          throw new Error("Report targets the actual parent; omit sessionId");
        if (!args.prompt?.trim()) throw new Error("report requires prompt");
        const metadata = await api.snapshot(WorkerDoc, api.conversationId, ctx);
        if (!metadata?.isSubagent || metadata.parentId === undefined || !metadata.completion)
          throw new Error("Only an assigned subagent can report to its parent");
        const parentId = metadata.parentId;
        const prompt = args.prompt;
        const assignmentId = metadata.completion.owner;
        const receiptKey = `progress-report:${api.taskId}`;
        const saved = await api.snapshot(DeliveryRecord, receiptKey, ctx);
        const assignment = await api.getTask(assignmentId, ctx);
        const remote = (assignment?.input as DeliveryInput | undefined)?.remoteAssignment;
        let content = saved?.progressContent;
        if (content === undefined) {
          const presentation = await services.resolvePresentation(api.conversationId, args);
          content = await api.commit(async (tx) => {
            const receipt = await tx.doc(DeliveryRecord, receiptKey, {});
            if (receipt.progressContent !== undefined) return receipt.progressContent;
            const worker = await tx.doc(WorkerDoc, api.conversationId);
            const outcome = {
              assignmentId,
              text: prompt,
              presentation: presentation as typeof presentation & Record<string, JsonValue>,
            };
            if (!worker.latestReport || Number(worker.latestReport.taskId) <= Number(api.taskId))
              worker.latestReport = { ...outcome, taskId: api.taskId };
            if (remote) {
              await tx.appendEntry(api.conversationId, {
                kind: "batty.remote-report",
                data: { ...outcome, assignment: remote, assignmentId: String(assignmentId) },
              });
            }
            receipt.progressContent = encodeRuntimeNotice({
              kind: "subagent",
              text: `[subagent ${api.conversationId} report]\n${describePresentation(prompt, presentation)}`,
              data: {
                runtimePresentation: presentation,
                runtimeNotice: {
                  text: `Subagent ${api.conversationId} report`,
                  markdown: prompt,
                },
                subagent: { sessionId: String(api.conversationId) },
              },
            });
            return receipt.progressContent;
          }, ctx);
        }
        if (remote)
          return reply(
            `Reported to remote parent. Session ID: ${api.conversationId}. Work may continue.`,
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
      if (args.action === "list" || args.action === "inspect") {
        if (args.action !== "list" || api.remoteAssignment || !services.remoteWorkers)
          return queryWorkers(args, api, ctx);
        const cursor = args.cursor
          ? (JSON.parse(args.cursor) as {
              source: "local" | "remote";
              local?: string;
              after?: string;
            })
          : { source: "local" as const };
        const limit = args.limit ?? 50;
        const local =
          cursor.source === "local"
            ? (JSON.parse(
                (await queryWorkers({ ...args, cursor: cursor.local }, api, ctx)).output[0]!.text,
              ) as { workers: unknown[]; nextCursor?: string })
            : { workers: [] as unknown[] };
        if (local.nextCursor)
          return reply(
            JSON.stringify({
              workers: local.workers,
              nextCursor: JSON.stringify({ source: "local", local: local.nextCursor }),
            }),
          );
        const remoteOrder = (left: { sessionId: string }, right: { sessionId: string }) =>
          right.sessionId.localeCompare(left.sessionId, "en", { numeric: true });
        const remotes = (
          services.remoteWorkers.list() as Array<{
            sessionId: string;
            workspaceId: string;
            status: string;
          }>
        )
          .filter(
            (worker) =>
              (args.status === "all" || worker.status === "running") &&
              (args.workspaceId === undefined || worker.workspaceId === args.workspaceId) &&
              (!cursor.after || remoteOrder(worker, { sessionId: cursor.after }) > 0),
          )
          .sort(remoteOrder);
        const page = remotes.slice(0, limit - local.workers.length);
        return reply(
          JSON.stringify({
            workers: [...local.workers, ...page],
            ...(page.length < remotes.length
              ? {
                  nextCursor: JSON.stringify({
                    source: "remote",
                    ...(page.length ? { after: page.at(-1)!.sessionId } : {}),
                  }),
                }
              : {}),
          }),
        );
      }
      const existingCall = (await api.snapshot(DeliveryRecord, String(api.taskId), ctx))?.call;
      const workerId = existingCall?.workerId ?? args.sessionId;
      const worker = workerId
        ? (state?.workers[workerId] ?? (await api.snapshot(ArchivedWorker, workerId, ctx)))
        : undefined;
      if (args.action !== "run" && (!worker || !(await api.conversation(worker.id, ctx))))
        throw missingWorker(workerId!);
      if (worker && !existingCall && args.action !== "await")
        await api.commit(async (tx) => {
          if (!(await tx.conversation(worker.id))) throw missingWorker(workerId!);
          const current = (await tx.doc(OrchestrationDoc)).workers[workerId!] ?? worker;
          const scope = await coordinationScope(tx, api.conversationId);
          if (!(await scope.visible(current)))
            throw new Error("Subagent is outside this session's coordination scope");
        }, ctx);
      const active =
        worker?.active === undefined ? undefined : await api.getTask(worker.active, ctx);
      const running = active !== undefined && active.state.status !== "terminal";
      if (
        args.action === "await" &&
        !api.remoteAssignment &&
        api.conversationId !== state!.mainId
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
          if (metadata.completion?.retiring)
            throw new Error("Cannot await while the subagent assignment is stopping");
          const completion = (metadata.completion ??= {
            owner: doc.workers[String(api.conversationId)]!.active!,
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
          const receipt = await tx.doc(DeliveryRecord, String(target), {});
          receipt.join = waiter ?? api.taskId;
          if (!waiting) {
            // The first await's continuation may be queued behind another
            // helper. Returning it here consumes that pending notification too.
            const joined =
              waiter === undefined
                ? undefined
                : await tx.submissionByRequest(api.conversationId, `batty-join:${waiter}`);
            if (!receipt.joinConsumed && !joined?.entry && !report?.entry)
              receipt.joinPresentationTask = api.taskId;
            receipt.joinConsumed = true;
            if (joined?.status === "queued") {
              tx.settleSubmission(joined.id, { status: "unanswered", reason: "aborted" });
              const inbox = await tx.doc(InboxDoc, api.conversationId);
              inbox.items = inbox.items.filter((item) => item.id !== joined.id);
              completion.inputs = completion.inputs.filter((id) => id !== joined.id);
            }
          }
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
        const receipt = await api.snapshot(DeliveryRecord, String(target), ctx);
        const presentation = receipt?.presentation;
        return {
          ...reply(
            `Subagent ${settled.state.outcome.status === "completed" ? "result" : settled.state.outcome.status}. Session ID: ${workerId}\n\n${
              typeof settled.state.outcome.result === "string"
                ? describePresentation(settled.state.outcome.result, presentation)
                : ""
            }`.trimEnd(),
          ),
          details:
            presentation && receipt?.joinPresentationTask === api.taskId
              ? { presentation: presentation as unknown as JsonValue }
              : {},
        };
      }
      if (args.action === "await")
        return {
          ...reply(
            running
              ? `Awaiting subagent. Session ID: ${workerId}`
              : `Subagent finished. Session ID: ${workerId}`,
          ),
          details: { assignmentId: String(worker!.active) },
          ...(running ? { control: { terminate: true as const } } : {}),
        };
      if (args.action === "stop") {
        // Capture the whole current delivery chain, not only its queued tail.
        // The memo keeps a replay from stopping later resumed work.
        const stop = await api.memo("batty.stop", (await captureStop(workerId!, ctx))!, ctx);
        const stoppingSelf = worker!.id === api.conversationId;
        // A worker cannot join its own delivery while that delivery is waiting
        // for this tool round to exit. All targets are still marked for abort.
        await applyStop(stop, ctx, !stoppingSelf);
        return reply(`${stoppingSelf ? "Stopping" : "Stopped"}. Session ID: ${workerId}`);
      }
      if (!args.prompt?.trim()) throw new Error(`${args.action} requires prompt`);
      const files =
        api.inputFiles ??
        (args.files
          ? await snapshotWorkerFiles(
              services.fileStorage ??
                (() => {
                  throw new Error("Worker file storage is not configured");
                })(),
              args.files,
              api,
              ctx,
              services.resolveFileSource,
            )
          : []);
      if (args.action === "steer") {
        const content = await encodeWorkerNotice(
          buildSubagentSteeringRuntimeNotice(args.prompt),
          files,
        );
        const child = (await api.conversation(worker!.id, ctx))!;
        await api.commit(async (tx) => {
          const requestId = `batty-steer:${api.taskId}`;
          if (await tx.submissionByRequest(worker!.id, requestId)) return;
          const completion = (await tx.doc(WorkerDoc, worker!.id)).completion;
          if (
            running &&
            !completion &&
            !(await tx.submissionByRequest(worker!.id, `batty-deliver:${worker!.active}`))
          )
            throw new Error("Cannot steer a preparing subagent; use queue");
          // Delivery remains nonterminal while reporting a closed assignment.
          // Check its open completion and admit steering on the same mutation line.
          if (
            !running ||
            !completion ||
            completion.retiring ||
            (await tx.task(completion.owner))?.state.status === "terminal"
          )
            throw new Error("Cannot steer a finished subagent; use resume");
          await child.submit(tx, {
            type: "input",
            content,
            whenBusy: "steer",
            requestId,
          });
        }, ctx);
        return reply(`Steered. Session ID: ${workerId}`);
      }
      const ws = await services.workspace(
        args.workspaceId ?? worker?.workspaceId,
        api.conversationId,
      );
      const inherited = await api.agent(ctx);
      const change = modelChange(args.model, args.effort);
      const admit = () =>
        api.commit(async (tx) => {
          const doc = await tx.doc(OrchestrationDoc);
          const call = await tx.doc(DeliveryRecord, String(api.taskId), {});
          const prior = call.call;
          if (args.sessionId && !(await tx.conversation(Number(args.sessionId) as ConversationId)))
            throw missingWorker(args.sessionId);
          if (prior) return { ...prior };
          const scope = await coordinationScope(tx, api.conversationId);
          if (args.sessionId && !doc.workers[args.sessionId]) {
            doc.workers[args.sessionId] = {
              ...(await tx.doc(ArchivedWorker, args.sessionId, worker!)),
            };
          }
          const currentWorker = args.sessionId ? doc.workers[args.sessionId] : undefined;
          if (currentWorker && !(await scope.visible(currentWorker)))
            throw new Error("Subagent is outside this session's coordination scope");
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
            const owner = await tx.createTask(Anchor, null, {
              ownership: { kind: "conversation" },
              background: true,
            });
            child = await createWorker(
              tx,
              owner,
              api.conversationId,
              ws,
              args.prompt!,
              inherited,
              change,
            );
          }
          const id = String(child);
          const input: DeliveryInput = {
            workerId: id,
            childId: child,
            mainId: doc.mainId!,
            prompt: args.prompt!,
            notice: buildSubagentRuntimeNotice(0, args.prompt!),
            ...(files.length ? { files } : {}),
            report: api.remoteAssignment === undefined,
            ...(api.remoteAssignment ? { remoteAssignment: api.remoteAssignment } : {}),
            change: { ...change, cwd: ws.path } as RunChange,
            workspaceId: ws.id,
          };
          if (args.action === "queue" && currentWorker?.active !== undefined)
            input.previous = currentWorker.active;
          const taskId = await tx.createTask(Delivery, input, {
            ownership: { kind: "conversation" },
            background: true,
          });
          doc.workers[id]!.active = taskId;
          doc.workers[id]!.startedAtMs = Date.now();
          doc.calls[String(api.taskId)] = { workerId: id, taskId };
          call.call = { workerId: id, taskId };
          return { workerId: id, taskId };
        }, ctx);
      const result = await admit();
      await api.details(
        {
          conversationId: Number(result.workerId),
          subagent: {
            sessionId: result.workerId,
            prompt: args.prompt,
            workspaceId: ws.id,
            respondIn: "session",
          },
        },
        ctx,
      );
      services.harness.resume();
      return reply(`Started. Session ID: ${result.workerId}`);
    },
  };
  const subagent = defineTool(workerTool);

  return {
    command: workerTool.execute,
    query(args: WorkerCommand, ctx: Context) {
      return queryWorkers(
        args,
        {
          conversationId: services.main.id,
          snapshot: services.harness.snapshot.bind(services.harness),
          commit: (fn, context) => services.main.commit(fn, context),
        },
        ctx,
      );
    },
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
