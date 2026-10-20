import { workerTools } from "./orchestration-worker-config.js";
import { modelChange } from "./orchestration-worker-config.js";
import type { Context, JsonValue } from "@earendil-works/chord";

import { Type } from "@earendil-works/pi-ai";
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

export type WorkerCommand = {
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
  prompt?: string;
  model?: string;
  effort?: string;
  workspaceId?: string;
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
> & { remoteAssignment?: { grantId: string; requestId: string } };

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
      const metadata = await tx.doc(WorkerDoc, id);
      if (metadata.isCron) return true;
      if (!metadata.isSubagent || metadata.parentId === undefined) return false;
      id = metadata.parentId;
    }
    return true;
  }

  async function coordinationScope(tx: Tx, callerId: ConversationId, assistantId?: string) {
    const state = await tx.doc(OrchestrationDoc);
    const caller = await tx.doc(WorkerDoc, callerId);
    const scope = await workerScope(tx, callerId, state.mainId!);
    if (!scope) throw new Error("Subagent tools require main or an assigned worker");
    const coordinator =
      callerId === state.mainId ||
      (assistantId !== undefined && caller.workspaceId === assistantId);
    return {
      canDelegate: (workspaceId: string) => coordinator || workspaceId === caller.workspaceId,
      visible: async (candidate: { id: ConversationId; workspaceId: string }) => {
        const candidateScope = await workerScope(tx, candidate.id, state.mainId!);
        if (!candidateScope) return false;
        return coordinator || candidate.workspaceId === caller.workspaceId;
      },
    };
  }

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
  const queryWorkers = async (
    args: WorkerCommand,
    api: Pick<WorkerCommandContext, "conversationId" | "snapshot" | "commit">,
    ctx: Context,
  ) => {
    const state = await api.snapshot(OrchestrationDoc, ctx);
    if (args.action === "inspect" && !args.sessionId) throw new Error("inspect requires sessionId");
    const page =
      args.action === "list"
        ? await api.commit(
            (tx) =>
              tx.scanConversations(
                {},
                args.limit ?? 50,
                args.cursor ? (JSON.parse(args.cursor) as Cursor) : undefined,
              ),
            ctx,
          )
        : undefined;
    const ids = page ? page.items.map((item) => String(item.id)) : [args.sessionId!];
    // Preload only archive seeds outside the transaction. Authorization,
    // workspace and output pointers are read together under the mutation line.
    const seeds = new Map<string, NonNullable<typeof state>["workers"][string]>();
    for (const id of ids) {
      const candidate = state?.workers[id] ?? (await api.snapshot(ArchivedWorker, id, ctx));
      if (candidate) seeds.set(id, candidate);
    }
    const assistantWorkspaceId = await services.assistantWorkspaceId();
    const local = await api.commit(async (tx) => {
      const state = await tx.doc(OrchestrationDoc);
      const findWorker = async (id: string) => {
        const seed = seeds.get(id);
        return state.workers[id] ?? (seed ? await tx.doc(ArchivedWorker, id, seed) : undefined);
      };
      const { visible } = await coordinationScope(tx, api.conversationId, assistantWorkspaceId);
      const summary = async (candidate: NonNullable<typeof state>["workers"][string]) => {
        const task = candidate.active === undefined ? undefined : await tx.task(candidate.active);
        return {
          sessionId: String(candidate.id),
          workspaceId: candidate.workspaceId,
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
          if (candidate && (await visible(candidate))) workers.push(await summary(candidate));
        }
        return reply(
          JSON.stringify({
            workers,
            ...(page?.next ? { nextCursor: JSON.stringify(page.next) } : {}),
          }),
        );
      }
      if (!args.sessionId) throw new Error("inspect requires sessionId");
      const candidate = await findWorker(args.sessionId);
      if (!candidate || !(await visible(candidate)))
        throw new Error("Unknown or inaccessible subagent");
      const status = await summary(candidate);
      const task = candidate.active === undefined ? undefined : await tx.task(candidate.active);
      const metadata = (await tx.doc(WorkerDoc, candidate.id))!;
      const latest = metadata.latestReport;
      const resultAssignment =
        metadata.latestResultAssignment ??
        (task?.state.status === "terminal" && task.state.outcome.status === "completed"
          ? candidate.active
          : undefined);
      const completed =
        resultAssignment === undefined ? undefined : await tx.task(resultAssignment);
      const result =
        completed?.state.status === "terminal" &&
        completed.state.outcome.status === "completed" &&
        (!latest || Number(resultAssignment) >= Number(latest.assignmentId))
          ? {
              kind: "result",
              assignmentId: String(resultAssignment),
              text: completed.state.outcome.result as string,
              artifacts:
                (await tx.doc(DeliveryRecord, String(resultAssignment), {})).artifacts ?? {},
            }
          : latest
            ? {
                kind: "report",
                assignmentId: String(latest.assignmentId),
                text: latest.text,
                artifacts: latest.artifacts,
              }
            : undefined;
      // Descriptors in details are consumed by attach_artifacts, not automatically attached.
      return {
        ...reply(
          JSON.stringify({
            ...status,
            ...(result
              ? {
                  latest: {
                    kind: result.kind,
                    assignmentId: result.assignmentId,
                    text: reportWithArtifacts(result.text.slice(0, 16_000), result.artifacts),
                    truncated: result.text.length > 16_000,
                  },
                }
              : {}),
          }),
        ),
        details: JSON.parse(JSON.stringify(result?.artifacts ?? {})) as Record<string, JsonValue>,
      };
    }, ctx);
    return local;
  };
  const workerTool = {
    name: "subagent",
    description:
      "Run, await, queue, resume, steer or stop subagents. Remote instances: workspaces lists configured nodes and their workspaces, including isAssistant. Pass nodeId to run remotely; returned remote Session IDs work with lifecycle actions without repeating nodeId. Remote workers use the receiving installation's models, tools and context. Coordinator list includes remote mirrors. File artifacts are imported locally; sites and live browsers are not relayed. Workers always run asynchronously: run, queue and resume return a Session ID immediately, without waiting for completion. Start workers with run, then use await to join their results. run creates a new session and rejects sessionId; await/queue/resume/steer/stop require sessionId. queue/resume/steer/stop use the same coordination scope as discovery; worker await joins a direct child. Project workers, including cron workers, delegate within their own workspace; main and assistant-workspace coordinators may delegate across workspaces. These are coordination guardrails, not a security boundary. list discovers subagents (stable sessionId, workspace, status), scanning up to limit conversations per page (default 50, max 100); pass nextCursor back as cursor even for empty pages. inspect returns status and the latest explicit report or terminal result without waiting or transcript access. All assigned workers, including cron roots and descendants, can discover, inspect and explicitly manage ordinary and cron workers in their own workspace. Main and workers in the configured assistant workspace can do so across all workspaces. Cron runs and their queues remain distinct; cron ancestry does not restrict coordination. inspect artifacts can be forwarded with attach_artifacts. Both actions are read-only; they do not join or acknowledge results. Workers can report an explicit intermediate update to their actual parent with action=report and prompt, without ending their work; currently attached artifacts accompany the report. No sessionId is accepted for report. Commentary is not forwarded. Start a subagent, await it, then use its result. Start multiple helpers before awaiting to run them in parallel. Reuse the Session ID returned by this tool for await, queue, resume, steer or stop; never guess an ID or use a memory-entry ID.",
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
            "Remote installation ID. Use workspaces to discover configured nodes and their workspaces. Omit for local execution; remote session IDs already identify the node.",
        }),
      ),
      sessionId: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      cursor: Type.Optional(Type.String()),
      prompt: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      effort: Type.Optional(Type.String()),
      workspaceId: Type.Optional(Type.String()),
    }),
    execute: async (args: WorkerCommand, api: WorkerCommandContext, ctx: Context) => {
      const remoteCoordinator = async () => {
        const state = await api.snapshot(OrchestrationDoc, ctx);
        if (api.conversationId === state?.mainId) return true;
        const caller = await api.snapshot(WorkerDoc, api.conversationId, ctx);
        const assistant = await services.assistantWorkspaceId();
        return assistant !== undefined && caller?.workspaceId === assistant;
      };
      if (args.action === "workspaces") {
        if (!(await remoteCoordinator()))
          throw new Error("Remote discovery requires the assistant coordinator");
        if (!services.remoteWorkers) return reply("[]");
        return reply(JSON.stringify(await services.remoteWorkers.workspaces(args.nodeId)));
      }
      if (args.nodeId || args.sessionId?.startsWith("remote:")) {
        if (!(await remoteCoordinator()))
          throw new Error("Remote delegation requires the assistant coordinator");
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
            const worker = await tx.doc(WorkerDoc, api.conversationId);
            if (!worker.latestReport || Number(worker.latestReport.taskId) <= Number(api.taskId))
              worker.latestReport = {
                taskId: api.taskId,
                assignmentId: metadata.completion!.owner,
                text: args.prompt!,
                artifacts: artifacts as typeof artifacts & Record<string, JsonValue>,
              };
            const assignment = await tx.task(metadata.completion!.owner);
            if ((assignment?.input as DeliveryInput | undefined)?.remoteAssignment) {
              const receipt = await tx.doc(DeliveryRecord, `remote-report:${api.taskId}`, {});
              if (!receipt.directDelivered) {
                await tx.appendEntry(api.conversationId, {
                  kind: "batty.remote-report",
                  data: {
                    assignment: (assignment!.input as unknown as DeliveryInput).remoteAssignment!,
                    assignmentId: String(metadata.completion!.owner),
                    text: args.prompt!,
                    artifacts: artifacts as typeof artifacts & Record<string, JsonValue>,
                  },
                });
                receipt.directDelivered = true;
              }
            }
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
        const assignment = await api.getTask(metadata.completion.owner, ctx);
        if ((assignment?.input as DeliveryInput | undefined)?.remoteAssignment)
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
        const local = await queryWorkers(args, api, ctx);
        if (
          args.action === "list" &&
          !api.remoteAssignment &&
          services.remoteWorkers &&
          !args.cursor &&
          (await remoteCoordinator())
        ) {
          const result = JSON.parse(local.output[0]!.text) as { workers: unknown[] };
          result.workers.push(...services.remoteWorkers.list());
          return reply(JSON.stringify(result));
        }
        return local;
      }
      const existingCall = (await api.snapshot(DeliveryRecord, String(api.taskId), ctx))?.call;
      const workerId = existingCall?.workerId ?? args.sessionId;
      const worker = workerId
        ? (state?.workers[workerId] ?? (await api.snapshot(ArchivedWorker, workerId, ctx)))
        : undefined;
      if (args.action !== "run" && !worker) throw new Error(`Unknown subagent: ${workerId}`);
      const assistantWorkspaceId = await services.assistantWorkspaceId();
      if (worker && !existingCall && args.action !== "await")
        await api.commit(async (tx) => {
          const current = (await tx.doc(OrchestrationDoc)).workers[workerId!] ?? worker;
          const scope = await coordinationScope(tx, api.conversationId, assistantWorkspaceId);
          if (!(await scope.visible(current)))
            throw new Error("Subagent is outside this session's coordination scope");
        }, ctx);
      const active =
        worker?.active === undefined ? undefined : await api.getTask(worker.active, ctx);
      const running = active !== undefined && active.state.status !== "terminal";
      if (
        args.action === "await" &&
        !api.remoteAssignment &&
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
          details: { assignmentId: String(worker!.active) },
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
      const change = modelChange(args.model, args.effort);
      const admit = () =>
        api.commit(async (tx) => {
          const doc = await tx.doc(OrchestrationDoc);
          const call = await tx.doc(DeliveryRecord, String(api.taskId), {});
          const prior = call.call;
          if (prior) return { ...prior };
          const scope = await coordinationScope(tx, api.conversationId, assistantWorkspaceId);
          if (!scope.canDelegate(ws.id))
            throw new Error(
              "Project workers delegate within their own workspace; ask the assistant coordinator for cross-workspace work",
            );
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
