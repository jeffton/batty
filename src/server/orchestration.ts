import { randomUUID } from "node:crypto";
import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type, type Message, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  AgentDoc,
  LiveDoc,
  InboxDoc,
  GenerationTask,
  hook,
  configure,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  type Agent,
  type AgentChange,
  type AgentState,
  type Conversation,
  type ConversationId,
  type EntryId,
  type Harness,
  type ModelRef,
  type SubmissionId,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
import { Cron } from "croner";
import type { WorkspaceInfo } from "../shared/types.js";
import { NO_REPLY_SENTINEL } from "../shared/agent-notification.js";
import type { AppConfig } from "./config.js";
import { listWorkspaces } from "./workspaces.js";
import {
  buildCronRuntimeNotice,
  buildSubagentRuntimeNotice,
  buildSubagentSteeringRuntimeNotice,
  decodeRuntimeNotice,
  encodeRuntimeNotice,
  type RuntimeNotice,
} from "./runtime-notices.js";

import { runtimeResultArtifacts } from "./runtime-result-artifacts.js";
import { reportWithAttachments } from "./attachment-contract.js";
import { reportWithArtifacts } from "./artifact-forwarding.js";
import type { AgentTurnArtifacts } from "./agent-turn-file-changes.js";
import { MAIN_MEMORY_TOOLS, withoutMainMemory } from "./main-memory-policy.js";

import {
  ArchivedWorker,
  ArchivedRun,
  DeliveryRecord,
  indexRun,
  readRuns,
  type WorkerRecord,
} from "./orchestration-history";
import { conversationPolicy } from "./conversation-policy";

const context = BACKGROUND_CONTEXT;
export type ContextMode = boolean | "chat-only";
export type ContextProvider = (
  parentId: ConversationId,
  mode: ContextMode,
) => Promise<readonly Message[]>;
export type PrepareAgent = (cwd: string, agent: Agent, context: Context) => Promise<AgentChange>;
type InlineContext = {
  cwd: string | null;
  model: ModelRef | null;
  thinkingLevel: ModelThinkingLevel;
  runId: string;
  selection?: {
    extensions: NonNullable<AgentState["extensions"]> | null;
    tools: NonNullable<AgentState["tools"]> | null;
  };
};
async function restoreInlineAgent(tx: Tx, id: ConversationId, saved: InlineContext) {
  await configure(tx, id, {
    cwd: saved.cwd,
    model: saved.model,
    thinkingLevel: saved.thinkingLevel,
  });
  if (saved.selection) {
    const state = await tx.doc(AgentDoc, id);
    if (saved.selection.extensions === null) delete state.extensions;
    else state.extensions = saved.selection.extensions;
    if (saved.selection.tools === null) delete state.tools;
    else state.tools = saved.selection.tools;
  }
}
export type ScheduleInput =
  | { kind: "at"; at?: string; in?: string }
  | { kind: "every"; every: string }
  | { kind: "cron"; expression: string; timezone?: string };
type Schedule =
  | { kind: "at"; at: string }
  | { kind: "every"; every: string; everyMs: number }
  | { kind: "cron"; expression: string; timezone: string };
export type CronSession = {
  kind: "new" | "daily-inline" | "main-inline" | "daily-detached" | "main-detached";
  includePreviousContext?: ContextMode;
};
export type CronDelivery = "direct" | "assistant";
function validateDelivery(delivery?: CronDelivery) {
  if (delivery !== undefined && !["direct", "assistant"].includes(delivery))
    throw new Error("Invalid cron delivery mode");
}
export type CronJobInput = {
  delivery?: CronDelivery;
  workspaceId?: string;
  enabled?: boolean;
  prompt: string;
  model?: string;
  thinkingLevel?: string;
  schedule: ScheduleInput;
  session?: CronSession;
};
export type CronJob = {
  delivery?: CronDelivery;
  id: string;
  workspaceId: string;
  enabled: boolean;
  prompt: string;
  model?: string;
  thinkingLevel?: string;
  schedule: Schedule;
  session: CronSession;
  nextAt?: number;
  retryAt?: number;
  createdAt: number;
  updatedAt: number;
};
type Worker = WorkerRecord;
export type CronRun = {
  id: string;
  jobId: string;
  workspaceId: string;
  scheduledAt: number;
  startedAt: number;
  taskId: TaskId<string>;
  sessionId: string;
  status: "running" | "completed" | "failed" | "aborted";
  finishedAt?: number;
  output?: string;
  job?: CronJob;
};

function removeCompletedOneShot(jobs: Record<string, CronJob>, run: CronRun) {
  const job = jobs[run.jobId];
  if (
    job?.schedule.kind === "at" &&
    !job.enabled &&
    job.nextAt === undefined &&
    job.updatedAt <= run.startedAt &&
    run.status === "completed" &&
    run.finishedAt !== undefined
  ) {
    run.job ??= JSON.parse(JSON.stringify(job)) as CronJob;
    delete jobs[job.id];
  }
}
/** Session-wide worker registry; subagent results belong to their spawning parent. */
export const OrchestrationDoc = defineDoc<{
  mainId?: ConversationId;
  inlineContext?: InlineContext;
  workers: Record<string, Worker>;
  calls: Record<string, { workerId: string; taskId: TaskId<string> }>;
  joins?: Record<string, TaskId>;
  resultArtifacts?: Record<string, AgentTurnArtifacts & Record<string, JsonValue>>;
  joinParents?: Record<string, SubmissionId>;
  jobs: Record<string, CronJob>;
  runs: Record<string, CronRun>;
  archived?: boolean;
}>({
  kind: "batty.orchestration",
  version: 1,
  scope: "session",
  initial: () => ({ workers: {}, calls: {}, jobs: {}, runs: {} }),
  checkpointWhen: (_, __, info) => info.deltasSinceBase >= 31,
});

export const WorkerDoc = defineDoc<{
  workspaceId?: string;
  parentId?: ConversationId;
  isSubagent: boolean;
  isCron: boolean;
  cronJobId?: string;
}>({
  kind: "batty.worker",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ isSubagent: false, isCron: false }),
});

async function archiveWorker(tx: Tx, workerId: string, taskId: TaskId<string>) {
  const doc = await tx.doc(OrchestrationDoc);
  const worker = doc.workers[workerId];
  for (const [id, call] of Object.entries(doc.calls)) {
    if (call.taskId === taskId) delete doc.calls[id];
  }
  if (worker?.active === taskId) {
    for (const call of Object.values(doc.calls)) {
      if (call.workerId === workerId && (await tx.task(call.taskId))?.state.status !== "terminal")
        return;
    }
    Object.assign(await tx.doc(ArchivedWorker, workerId, worker), worker);
    delete doc.workers[workerId];
  }
}

export interface OrchestrationConfig {
  config?: unknown;
  workspaces?:
    | readonly WorkspaceInfo[]
    | (() => readonly WorkspaceInfo[] | Promise<readonly WorkspaceInfo[]>);
  mainId?: ConversationId;
  /** Prepared provider context, not immutable storage history. Required for context copies. */
  contextFor?: ContextProvider;
  prepareAgent?: PrepareAgent;
  /** Used when the host's workspace list is managed by a service. */
  resolveWorkspace?: (
    id?: string,
    parentId?: ConversationId,
  ) => Promise<Pick<WorkspaceInfo, "id" | "path">>;
  onError?: (error: unknown) => void;
}

export function parseDuration(value: string): number {
  const compact = value.toLowerCase().replace(/\s/g, "");
  const matches = [...compact.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d|w)/g)];
  if (matches.map((m) => m[0]).join("") !== compact || !matches.length)
    throw new Error(`Invalid duration: ${value}`);
  const units: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60000,
    h: 3600000,
    d: 86400000,
    w: 604800000,
  };
  const ms = Math.round(matches.reduce((n, m) => n + Number(m[1]) * units[m[2]!]!, 0));
  if (!Number.isFinite(ms) || ms <= 0) throw new Error(`Invalid duration: ${value}`);
  return ms;
}
function normalizeSchedule(input: ScheduleInput, now: number): Schedule {
  if (input.kind === "every") return { ...input, everyMs: parseDuration(input.every) };
  if (input.kind === "cron") {
    const schedule = { ...input, timezone: input.timezone ?? "UTC" };
    new Cron(schedule.expression, { timezone: schedule.timezone, paused: true }).stop();
    return schedule;
  }
  const at = input.in ? now + parseDuration(input.in) : Date.parse(input.at!);
  if (!Number.isFinite(at) || at <= now) throw new Error("At schedule must be in the future");
  return { kind: "at", at: new Date(at).toISOString() };
}
function nextAt(schedule: Schedule, after: number): number | undefined {
  if (schedule.kind === "at")
    return Date.parse(schedule.at) > after ? Date.parse(schedule.at) : undefined;
  if (schedule.kind === "every") return after + schedule.everyMs;
  const cron = new Cron(schedule.expression, { timezone: schedule.timezone, paused: true });
  const result = cron.nextRun(new Date(after))?.getTime();
  cron.stop();
  return result;
}
function modelChange(model?: string, effort?: string): AgentChange {
  const change: AgentChange = {};
  if (model) {
    const slash = model.indexOf("/");
    if (slash < 1) throw new Error("Model must be provider/modelId");
    (change as { model: { provider: string; modelId: string } }).model = {
      provider: model.slice(0, slash),
      modelId: model.slice(slash + 1),
    };
  }
  if (effort) {
    if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(effort))
      throw new Error(`Invalid thinking level: ${effort}`);
    (change as { thinkingLevel: ModelThinkingLevel }).thinkingLevel = effort as ModelThinkingLevel;
  }
  return change;
}
function reply(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

type RunChange = {
  cwd?: string | null;
  model?: ModelRef | null;
  thinkingLevel?: ModelThinkingLevel | null;
};
type DeliveryInput = {
  delivery?: CronDelivery;
  workerId: string;
  childId: ConversationId;
  mainId: ConversationId;
  prompt: string;
  notice?: RuntimeNotice;
  report: boolean;
  previous?: TaskId<string>;
  runId?: string;
  inline?: boolean;
  change?: RunChange;
  workspaceId?: string;
};
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

function workerTools(agent: Agent, workspaceId: string): string[] {
  const memoryTools = conversationPolicy("worker", workspaceId).mainMemory
    ? agent.extensions.flatMap((extension) =>
        extension.name === "batty-optchat" ? (extension.tools ?? []) : [],
      )
    : [];
  return [
    ...new Set(
      [...agent.tools, ...memoryTools]
        .filter(
          (tool) =>
            tool.name !== "memory_overview" &&
            (conversationPolicy("worker", workspaceId).mainMemory ||
              !MAIN_MEMORY_TOOLS.has(tool.name)),
        )
        .map((tool) => tool.name),
    ),
  ];
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

export interface WorkerBrowserLifecycle {
  admit<T>(id: string, operation: () => Promise<T>): Promise<T>;
  stop(id: string, taskId: string): Promise<void>;
}

export function createOrchestration(input: OrchestrationConfig | AppConfig = {}) {
  const options: OrchestrationConfig =
    "workspacesRoots" in input ? { config: input, workspaces: () => listWorkspaces(input) } : input;
  let harness: Harness;
  let main: Conversation;
  let contextFor = options.contextFor;
  let prepareAgent = options.prepareAgent;
  let browserLifecycle: WorkerBrowserLifecycle | undefined;
  const preparedContext = async (
    parentId: ConversationId,
    mode: ContextMode,
    workspaceId: string,
  ): Promise<readonly Message[]> => {
    if (mode === false) return [];
    if (!contextFor)
      throw new Error("Context copying requires orchestration.setContextProvider(fn)");
    const copied = await contextFor(parentId, mode);
    const messages = conversationPolicy("worker", workspaceId).mainMemory
      ? copied
      : withoutMainMemory(copied);
    if (mode !== "chat-only") return messages;
    return messages.flatMap<Message>((message) => {
      if (message.role === "user") return [message];
      if (message.role !== "assistant") return [];
      const content = message.content.filter(
        (part) => part.type !== "thinking" && part.type !== "toolCall",
      );
      return content.length ? [{ ...message, content }] : [];
    });
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const onError = options.onError ?? console.error;
  const workspace = async (id?: string, parentId?: ConversationId) => {
    if (options.resolveWorkspace) return options.resolveWorkspace(id, parentId);
    const list =
      typeof options.workspaces === "function"
        ? await options.workspaces()
        : (options.workspaces ?? []);
    const inherited =
      parentId === undefined
        ? undefined
        : (
            (await harness.snapshot(OrchestrationDoc, context))?.workers[String(parentId)] ??
            (await harness.snapshot(ArchivedWorker, String(parentId), context))
          )?.workspaceId;
    const parentCwd =
      parentId === undefined
        ? undefined
        : (await (await harness.conversation(parentId, context))!.agent(context)).cwd;
    const found =
      id || inherited
        ? list.find((w) => w.id === (id ?? inherited))
        : (list.find((w) => w.path === parentCwd) ?? list.find((w) => w.isAssistant) ?? list[0]);
    if (!found) throw new Error(`Unknown workspace: ${id ?? inherited ?? "default"}`);
    return found;
  };
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
          if (prepareAgent) {
            const live = await runtime.snapshot(LiveDoc, task.input.childId, ctx);
            const inbox = await runtime.snapshot(InboxDoc, task.input.childId, ctx);
            const state = await runtime.snapshot(OrchestrationDoc, ctx);
            if (!live?.run && !inbox?.items.length && !state?.inlineContext) {
              preparedFrom = await runtime.snapshot(AgentDoc, task.input.childId, ctx);
              const agent = await main.agent(ctx);
              prepared = await prepareAgent(task.input.change?.cwd ?? agent.cwd!, agent, ctx);
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
              prepareAgent &&
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
              await main.submit(
                { type: "write", entry: { kind: "batty.cron-wake" }, requestId: wakeRequest },
                ctx,
              );
            return;
          }
        } else {
          let admitted = false;
          const childAgent = await (await harness.conversation(task.input.childId, ctx))!.agent(
            ctx,
          );
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
          if (prepareAgent && !admitted) {
            const child = (await harness.conversation(task.input.childId, ctx))!;
            const agent = await child.agent(ctx);
            const prepared = await prepareAgent(agent.cwd!, agent, ctx);
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
        const settled = await (await harness.submission(submissionId, ctx))!.wait(ctx);
        let artifacts: AgentTurnArtifacts | undefined;
        if (settled.status === "done" && settled.type === "input") {
          const child = (await harness.conversation(task.input.childId, ctx))!;
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
      const record = await harness.commit(
        (tx) => tx.submissionByRequest(task.input.childId, `batty-deliver:${task.id}`),
        ctx,
      );
      if (record && record.status === "queued")
        await (await harness.submission(record.id, ctx))!.abort(ctx);
      if (record && record.status === "placed") {
        const live = await runtime.snapshot(LiveDoc, task.input.childId, ctx);
        if (live?.run?.inputs.includes(record.id)) {
          await harness.abortTask(live.run.taskId, ctx);
          await harness.waitForTask(live.run.taskId, ctx);
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
    (await tx.doc(AgentDoc, child.id)).tools = workerTools(parentAgent, ws.id);
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
  const subagent = defineTool({
    name: "subagent",
    description:
      "Run, await, queue, resume, steer or stop subagents. Start a subagent, await it, then use its result. Start multiple async helpers before awaiting to run them in parallel. Reuse the Session ID returned by this tool for await, queue, resume, steer or stop; never guess an ID or use a memory-entry ID.",
    replay: "safe",
    parameters: Type.Object({
      action: Type.Union(
        (["run", "await", "queue", "resume", "steer", "stop"] as const).map((value) =>
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
        await api.commit(async (tx) => {
          const doc = await tx.doc(OrchestrationDoc);
          (await tx.doc(DeliveryRecord, String(target), {})).join = api.taskId;
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
          const report = await tx.submissionByRequest(api.conversationId, `batty-report:${target}`);
          if (report?.status === "queued") {
            tx.settleSubmission(report.id, { status: "unanswered", reason: "aborted" });
            const inbox = await tx.doc(InboxDoc, api.conversationId);
            inbox.items = inbox.items.filter((item) => item.id !== report.id);
          }
        }, ctx);
        // No terminate control: the generation remains live while this tool waits.
        // waitForTask replays safely after restart; completion resumes the model.
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
        const candidates = [
          ...new Set([
            ...Object.values(state!.calls)
              .filter((call) => call.workerId === workerId)
              .map((call) => call.taskId),
            ...(worker!.active === undefined ? [] : [worker!.active]),
          ]),
        ];
        const live: TaskId<string>[] = [];
        for (const id of candidates)
          if ((await api.getTask(id, ctx))?.state.status !== "terminal") live.push(id);
        const stop = await api.memo(
          "batty.stop",
          {
            targets: live,
            browserTask: worker!.active === undefined ? null : String(worker!.active),
          },
          ctx,
        );
        for (const target of [...stop.targets].reverse()) await harness.abortTask(target, ctx);
        if (stop.browserTask !== null) await browserLifecycle?.stop(workerId!, stop.browserTask);
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
      const ws = await workspace(args.workspaceId ?? worker?.workspaceId, api.conversationId);
      const inherited = await api.agent(ctx);
      const prefix =
        args.action === "run" && !existingCall
          ? await preparedContext(api.conversationId, args.includePreviousContext ?? false, ws.id)
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
        args.sessionId && browserLifecycle
          ? await browserLifecycle.admit(args.sessionId, admit)
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
      harness.resume();
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

  const snapshot = async () => (await harness.snapshot(OrchestrationDoc, context))!;
  const listJobs = async (workspaceId?: string) =>
    Object.values((await snapshot()).jobs).filter(
      (j) => workspaceId === undefined || j.workspaceId === workspaceId,
    );
  const listRunLogs = async (jobId?: string, limit = 100, workspaceId?: string) =>
    readRuns(harness, context, jobId, limit, workspaceId);
  const listRunningCron = async (jobId?: string) => {
    const running: CronRun[] = [];
    for (const run of Object.values((await snapshot()).runs)) {
      const task = await harness.getTask(run.taskId, context);
      if (task?.state.status !== "terminal") {
        if (!jobId || run.jobId === jobId) running.push(run);
        continue;
      }
      const outcome = task.state.outcome;
      await main.commit(async (tx) => {
        const doc = await tx.doc(OrchestrationDoc);
        const current = doc.runs[run.id];
        if (!current || current.taskId !== run.taskId) return;
        current.status =
          outcome.status === "completed"
            ? "completed"
            : outcome.status === "aborted"
              ? "aborted"
              : "failed";
        current.finishedAt = Date.now();
        if (doc.inlineContext?.runId === current.id) {
          await restoreInlineAgent(tx, main.id, doc.inlineContext);
          delete doc.inlineContext;
        }
        removeCompletedOneShot(doc.jobs, current);
        Object.assign(await tx.doc(ArchivedRun, current.id, current), current);
        delete doc.runs[current.id];
        await archiveWorker(tx, current.sessionId, current.taskId);
      }, context);
    }
    return running;
  };
  const tick = async () => {
    if (closed) return;
    const now = Date.now();
    await listRunningCron();
    const jobs = await listJobs();
    for (const job of jobs) {
      if (
        !job.enabled ||
        job.nextAt === undefined ||
        job.nextAt > now ||
        (job.retryAt !== undefined && job.retryAt > now)
      )
        continue;
      try {
        const ws = await workspace(job.workspaceId);
        const agent = await main.agent(context);
        const inline =
          job.delivery !== "direct" &&
          (job.session.kind === "daily-inline" || job.session.kind === "main-inline");
        const prefix = inline
          ? []
          : await preparedContext(main.id, job.session.includePreviousContext ?? false, ws.id);
        await main.commit(async (tx) => {
          const doc = await tx.doc(OrchestrationDoc);
          const current = doc.jobs[job.id];
          if (!current?.enabled || JSON.stringify(current) !== JSON.stringify(job)) return;
          const runId = `${job.id}:${job.nextAt}`;
          if (doc.runs[runId]) return;
          const anchor = inline
            ? undefined
            : await tx.createTask(Anchor, null, {
                ownership: { kind: "conversation" },
                background: true,
              });
          const child = inline
            ? main.id
            : await createWorker(
                tx,
                anchor!,
                main.id,
                ws,
                job.prompt,
                agent,
                modelChange(job.model, job.thinkingLevel),
                prefix,
              );
          if (!inline) {
            const metadata = await tx.doc(WorkerDoc, child);
            metadata.isCron = true;
            metadata.isSubagent = false;
            metadata.cronJobId = job.id;
          }
          const taskId = await tx.createTask(
            Delivery,
            {
              workerId: String(child),
              childId: child,
              mainId: main.id,
              prompt: job.prompt,
              notice: {
                ...buildCronRuntimeNotice({
                  scheduleLabel: JSON.stringify(job.schedule),
                  prompt: job.prompt,
                  session:
                    job.delivery === "direct" && job.session.kind.endsWith("inline")
                      ? {
                          ...job.session,
                          kind:
                            job.session.kind === "daily-inline"
                              ? "daily-detached"
                              : "main-detached",
                        }
                      : job.session,
                  now: new Date(now),
                }),
                data: { cron: { workspaceId: ws.id, cwd: ws.path, runId } },
              },
              report: !inline,
              delivery: job.delivery ?? "assistant",
              runId,
              inline,
              change: { ...modelChange(job.model, job.thinkingLevel), cwd: ws.path } as RunChange,
              workspaceId: ws.id,
            },
            { ownership: { kind: "conversation" }, background: true },
          );
          if (!inline) doc.workers[String(child)]!.active = taskId;
          doc.runs[runId] = {
            id: runId,
            jobId: job.id,
            workspaceId: ws.id,
            scheduledAt: job.nextAt!,
            startedAt: now,
            taskId,
            sessionId: String(child),
            status: "running",
            job: structuredClone(job),
          };
          await indexRun(tx, doc.runs[runId]!);
          current.nextAt =
            current.schedule.kind === "every"
              ? job.nextAt! +
                (Math.floor((now - job.nextAt!) / current.schedule.everyMs) + 1) *
                  current.schedule.everyMs
              : nextAt(current.schedule, now);
          delete current.retryAt;
          if (current.schedule.kind === "at") {
            current.enabled = false;
            delete current.nextAt;
          }
        }, context);
        harness.resume();
      } catch (error) {
        onError(error);
        await main.commit(async (tx) => {
          const current = (await tx.doc(OrchestrationDoc)).jobs[job.id];
          if (current && JSON.stringify(current) === JSON.stringify(job))
            current.retryAt = Date.now() + 60000;
        }, context);
      }
    }
  };
  const arm = async () => {
    if (timer) clearTimeout(timer);
    if (closed) return;
    const due = (await listJobs())
      .filter((j) => j.enabled && j.nextAt !== undefined)
      .map((j) => Math.max(j.nextAt!, j.retryAt ?? 0));
    const delay = Math.max(1, Math.min(60000, Math.min(...due) - Date.now()));
    timer = setTimeout(() => {
      void tick()
        .catch(onError)
        .finally(() => arm().catch(onError));
    }, delay);
    timer.unref();
  };
  const addJob = async (input: CronJobInput) => {
    validateDelivery(input.delivery);
    if (!input.prompt.trim()) throw new Error("Cron prompt is required");
    modelChange(input.model, input.thinkingLevel);
    if (
      input.session &&
      !["new", "daily-inline", "main-inline", "daily-detached", "main-detached"].includes(
        input.session.kind,
      )
    )
      throw new Error("Invalid cron session mode");
    const ws = await workspace(input.workspaceId);
    const now = Date.now();
    const schedule = normalizeSchedule(input.schedule, now);
    const job: CronJob = {
      id: randomUUID(),
      workspaceId: ws.id,
      enabled: input.enabled ?? true,
      prompt: input.prompt,
      schedule,
      session: input.session ?? { kind: "new" },
      delivery: input.delivery ?? "assistant",
      createdAt: now,
      updatedAt: now,
    };
    if (input.model) job.model = input.model;
    if (input.thinkingLevel) job.thinkingLevel = input.thinkingLevel;
    const next = nextAt(schedule, now);
    if (next !== undefined) job.nextAt = next;
    await main.commit(async (tx) => {
      (await tx.doc(OrchestrationDoc)).jobs[job.id] = job;
    }, context);
    await arm();
    return job;
  };
  const importJob = async (input: CronJob) => {
    validateDelivery(input.delivery);
    if (!input.id || !input.prompt.trim()) throw new Error("Cron id and prompt are required");
    if (typeof input.enabled !== "boolean") throw new Error("Cron enabled must be boolean");
    if (!Number.isFinite(input.createdAt) || !Number.isFinite(input.updatedAt))
      throw new Error("Invalid cron timestamp");
    for (const value of [input.nextAt, input.retryAt]) {
      if (value !== undefined && !Number.isFinite(value)) throw new Error("Invalid cron timestamp");
    }
    modelChange(input.model, input.thinkingLevel);
    if (
      !["new", "daily-inline", "main-inline", "daily-detached", "main-detached"].includes(
        input.session.kind,
      )
    )
      throw new Error("Invalid cron session mode");
    const mode = input.session.includePreviousContext;
    if (mode !== undefined && typeof mode !== "boolean" && mode !== "chat-only")
      throw new Error("Invalid cron context mode");
    const ws = await workspace(input.workspaceId);
    let schedule: Schedule;
    if (input.schedule.kind === "at") {
      if (!Number.isFinite(Date.parse(input.schedule.at))) throw new Error("Invalid at schedule");
      schedule = { kind: "at", at: input.schedule.at };
    } else {
      schedule = normalizeSchedule(input.schedule, Date.now());
    }
    const job: CronJob = {
      id: input.id,
      workspaceId: ws.id,
      enabled: input.enabled,
      prompt: input.prompt,
      session: structuredClone(input.session),
      ...(input.delivery !== undefined ? { delivery: input.delivery } : {}),
      schedule,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    };
    if (input.model !== undefined) job.model = input.model;
    if (input.thinkingLevel !== undefined) job.thinkingLevel = input.thinkingLevel;
    if (input.nextAt !== undefined) job.nextAt = input.nextAt;
    if (input.retryAt !== undefined) job.retryAt = input.retryAt;
    await main.commit(async (tx) => {
      const doc = await tx.doc(OrchestrationDoc);
      if (doc.jobs[job.id]) throw new Error(`Cron job already exists: ${job.id}`);
      doc.jobs[job.id] = job;
    }, context);
    await arm();
    return job;
  };
  const updateJob = async (id: string, input: Partial<CronJobInput>) => {
    validateDelivery(input.delivery);
    modelChange(input.model, input.thinkingLevel);
    if (
      input.session &&
      !["new", "daily-inline", "main-inline", "daily-detached", "main-detached"].includes(
        input.session.kind,
      )
    )
      throw new Error("Invalid cron session mode");
    const ws = input.workspaceId ? await workspace(input.workspaceId) : undefined;
    const now = Date.now();
    const schedule = input.schedule ? normalizeSchedule(input.schedule, now) : undefined;
    const job = await main.commit(async (tx) => {
      const doc = await tx.doc(OrchestrationDoc);
      const job = doc.jobs[id];
      if (!job) throw new Error(`Unknown cron job: ${id}`);
      if (input.prompt !== undefined) {
        if (!input.prompt.trim()) throw new Error("Cron prompt is required");
        job.prompt = input.prompt;
      }
      if (input.enabled !== undefined) job.enabled = input.enabled;
      if (input.model !== undefined) job.model = input.model;
      if (input.thinkingLevel !== undefined) job.thinkingLevel = input.thinkingLevel;
      if (input.session !== undefined) job.session = input.session;
      if (input.delivery !== undefined) job.delivery = input.delivery;
      if (ws) job.workspaceId = ws.id;
      if (schedule) job.schedule = schedule;
      if (schedule || (input.enabled === true && job.nextAt === undefined))
        job.nextAt = nextAt(job.schedule, now);
      job.updatedAt = now;
      delete job.retryAt;
      return JSON.parse(JSON.stringify(job)) as CronJob;
    }, context);
    await arm();
    return job;
  };
  const removeJob = async (id: string) => {
    await main.commit(async (tx) => {
      const jobs = (await tx.doc(OrchestrationDoc)).jobs;
      if (!jobs[id]) throw new Error(`Unknown cron job: ${id}`);
      delete jobs[id];
    }, context);
    await arm();
  };
  const stopRunning = async (runId: string) => {
    const run =
      (await snapshot()).runs[runId] ?? (await harness.snapshot(ArchivedRun, runId, context));
    if (!run) throw new Error(`Unknown cron run: ${runId}`);
    await harness.abortTask(run.taskId, context);
  };
  const cron = defineTool({
    name: "cron",
    description:
      "Manage scheduled tasks. daily-inline/main-inline use main's continuing context; daily-detached/main-detached use separate workers. delivery=assistant (default) lets the main assistant handle the result; delivery=direct shows the result unchanged to the user and always runs in a separate worker. Return NO_REPLY for no user-visible output.",
    replay: "unsafe",
    parameters: Type.Object({
      action: Type.String(),
      jobId: Type.Optional(Type.String()),
      runId: Type.Optional(Type.String()),
      workspaceId: Type.Optional(Type.String()),
      enabled: Type.Optional(Type.Boolean()),
      delivery: Type.Optional(Type.Union([Type.Literal("direct"), Type.Literal("assistant")])),
      prompt: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      thinkingLevel: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number()),
      session: Type.Optional(
        Type.Object({
          kind: Type.String(),
          includePreviousContext: Type.Optional(
            Type.Union([Type.Boolean(), Type.Literal("chat-only")]),
          ),
        }),
      ),
      schedule: Type.Optional(
        Type.Object({
          kind: Type.String(),
          at: Type.Optional(Type.String()),
          in: Type.Optional(Type.String()),
          every: Type.Optional(Type.String()),
          expression: Type.Optional(Type.String()),
          timezone: Type.Optional(Type.String()),
        }),
      ),
    }),
    execute: async (args, api) => {
      let result: unknown;
      switch (args.action) {
        case "list":
          result = await listJobs((await workspace(args.workspaceId, api.conversationId)).id);
          break;
        case "add":
          result = await addJob({
            ...args,
            workspaceId: (await workspace(args.workspaceId, api.conversationId)).id,
          } as CronJobInput);
          break;
        case "update":
          result = await updateJob(args.jobId!, args as Partial<CronJobInput>);
          break;
        case "remove":
          await removeJob(args.jobId!);
          result = "Removed.";
          break;
        case "list-running":
          result = await listRunningCron(args.jobId);
          break;
        case "list-run-logs":
          result = await listRunLogs(args.jobId, args.limit, args.workspaceId);
          break;
        case "stop-running": {
          if (args.runId) await stopRunning(args.runId);
          else for (const run of await listRunningCron(args.jobId)) await stopRunning(run.id);
          result = "Stopped.";
          break;
        }
        default:
          throw new Error(`Unknown cron action: ${args.action}`);
      }
      return reply(typeof result === "string" ? result : JSON.stringify(result));
    },
  });
  const extension = defineExtension({
    name: "batty-orchestration",
    tools: [subagent, cron],
    tasks: [Anchor, Delivery],
    hooks: [
      hook(GenerationTask, {
        beforeRequest: (request) => ({
          messages: request.messages.map((message) => {
            const notice = message.role === "user" && decodeRuntimeNotice(message.content);
            return notice ? { ...message, content: notice.text } : message;
          }),
        }),
      }),
      hook(GenerationTask, {
        // Inline turns use the originating workspace for tools. Save main's cwd
        // in the same commit so reopening can restore it after interruption.
        beforeRequest: async (_request, api, ctx) => {
          if (api.conversationId !== main.id) return;
          // The active run's admitted inputs survive zooms and later steering.
          // Read those immutable input entries rather than the prepared last user.
          const live = await api.snapshot(LiveDoc, main.id, ctx);
          const entries: EntryId[] = [];
          for (const id of live?.run?.inputs ?? []) {
            const submission = await (await harness.submission(id, ctx))!.status(ctx);
            if (submission.entry !== undefined) entries.push(submission.entry);
          }
          const agent = await main.agent(ctx);
          await main.commit(async (tx) => {
            let origin: { cwd: string; runId: string } | undefined;
            for (const id of entries) {
              const entry = await tx.entry(id);
              const message = entry?.model?.find((message) => message.role === "user");
              const text =
                message?.role === "user"
                  ? typeof message.content === "string"
                    ? message.content
                    : message.content
                        .flatMap((part) => (part.type === "text" ? [part.text] : []))
                        .join("")
                  : "";
              const notice = decodeRuntimeNotice(text);
              if (notice?.kind === "cron" && notice.data?.cron) {
                origin = notice.data.cron as { cwd: string; runId: string };
                break;
              }
              // Already-admitted inline runs retain their immutable old input.
              const legacy = /^<batty-cron-context>(.*?)<\/batty-cron-context>/s.exec(text);
              if (legacy) {
                origin = JSON.parse(legacy[1]!) as { cwd: string; runId: string };
                break;
              }
            }
            const doc = await tx.doc(OrchestrationDoc);
            if (origin) {
              doc.inlineContext ??= {
                cwd: agent.cwd ?? null,
                model: agent.model ?? null,
                thinkingLevel: agent.thinkingLevel,
                runId: origin.runId,
              };
              doc.inlineContext.runId = origin.runId;
              await configure(tx, main.id, { cwd: origin.cwd });
            } else if (doc.inlineContext) {
              await restoreInlineAgent(tx, main.id, doc.inlineContext);
              delete doc.inlineContext;
            }
          }, ctx);
        },
        afterTools: async (_assistant, _results, api, ctx) => {
          if (api.conversationId !== main.id) return;
          const live = await api.snapshot(LiveDoc, main.id, ctx);
          const controls = [];
          for (const tool of live?.tools ?? []) {
            const task =
              tool.taskId === undefined ? undefined : await harness.getTask(tool.taskId, ctx);
            const outcome = task?.state.status === "terminal" ? task.state.outcome : undefined;
            const control =
              outcome && "result" in outcome
                ? (
                    outcome.result as
                      | { control?: { terminate?: boolean; handoff?: string } }
                      | undefined
                  )?.control
                : undefined;
            controls.push(control);
          }
          if (
            !controls.some((control) => control?.handoff !== undefined) &&
            !(controls.length && controls.every((control) => control?.terminate))
          )
            return;
          await main.commit(async (tx) => {
            const doc = await tx.doc(OrchestrationDoc);
            if (!doc.inlineContext) return;
            await restoreInlineAgent(tx, main.id, doc.inlineContext);
            delete doc.inlineContext;
          }, ctx);
        },
        afterResponse: async (message, api, ctx) => {
          if (message.stopReason === "stop" || message.stopReason === "length") {
            await main.commit(async (tx) => {
              const doc = await tx.doc(OrchestrationDoc);
              if (doc.joinParents) delete doc.joinParents[String(api.conversationId)];
            }, ctx);
          }
          if (
            api.conversationId !== main.id ||
            (message.stopReason !== "stop" && message.stopReason !== "length")
          )
            return;
          await main.commit(async (tx) => {
            const doc = await tx.doc(OrchestrationDoc);
            if (!doc.inlineContext) return;
            await restoreInlineAgent(tx, main.id, doc.inlineContext);
            delete doc.inlineContext;
          }, ctx);
        },
      }),
    ],
  });
  return {
    extension,
    setWorkerBrowserLifecycle(lifecycle: WorkerBrowserLifecycle) {
      browserLifecycle = lifecycle;
    },
    setContextProvider(provider: ContextProvider) {
      contextFor = provider;
    },
    setPrepareAgent(provider: PrepareAgent) {
      prepareAgent = provider;
    },
    async bind(bound: Harness, root: Conversation) {
      harness = bound;
      main = root;
      closed = false;
      await main.commit(async (tx) => {
        const doc = await tx.doc(OrchestrationDoc);
        doc.mainId = options.mainId ?? main.id;
        if (!doc.archived) {
          for (const [id, call] of Object.entries(doc.calls)) {
            (await tx.doc(DeliveryRecord, id, {})).call = call;
            if ((await tx.task(call.taskId))?.state.status === "terminal") delete doc.calls[id];
          }
          for (const [id, join] of Object.entries(doc.joins ?? {})) {
            (await tx.doc(DeliveryRecord, id, {})).join = join;
          }
          for (const [id, artifacts] of Object.entries(doc.resultArtifacts ?? {})) {
            (await tx.doc(DeliveryRecord, id, {})).artifacts = artifacts;
          }
          delete doc.joins;
          delete doc.resultArtifacts;
          for (const [id, input] of Object.entries(doc.joinParents ?? {})) {
            if (!(await tx.doc(LiveDoc, Number(id) as ConversationId)).run?.inputs.includes(input))
              delete doc.joinParents![id];
          }
          for (const run of Object.values(doc.runs).sort((a, b) => a.startedAt - b.startedAt)) {
            await indexRun(tx, run);
            if (run.status !== "running") delete doc.runs[run.id];
          }
          for (const [id, worker] of Object.entries(doc.workers)) {
            if (
              worker.active === undefined ||
              (await tx.task(worker.active))?.state.status === "terminal"
            ) {
              Object.assign(await tx.doc(ArchivedWorker, id, worker), worker);
              delete doc.workers[id];
            }
          }
          doc.archived = true;
        }
      }, context);
      // Retire historical successful one-shots using the latest archived run,
      // never merely because a definition is paused or its deadline has passed.
      for (const job of await listJobs()) {
        if (job.schedule.kind !== "at" || job.enabled || job.nextAt !== undefined) continue;
        const runs = await listRunLogs(job.id, Infinity);
        const [run] = runs;
        if (!run) continue;
        await main.commit(async (tx) => {
          const doc = await tx.doc(OrchestrationDoc);
          const current = doc.jobs[job.id];
          if (!current || JSON.stringify(current) !== JSON.stringify(job)) return;
          // Preserve every legacy run's display metadata, including earlier failures.
          // Failed one-shots may succeed on a later explicitly requested run.
          for (const historical of runs) {
            const archived = await tx.doc(ArchivedRun, historical.id, historical);
            archived.job ??= structuredClone(job);
          }
          if (Object.values(doc.runs).some((active) => active.jobId === job.id)) return;
          removeCompletedOneShot(doc.jobs, run);
          Object.assign(await tx.doc(ArchivedRun, run.id, run), run);
        }, context);
      }
      await tick();
      await arm();
    },
    async listRunning(parentId?: ConversationId) {
      const workers = Object.values((await snapshot()).workers).filter(
        (w) => parentId === undefined || w.parentId === parentId,
      );
      const result = [];
      for (const worker of workers) {
        if (worker.active === undefined) continue;
        const task = await harness.getTask(worker.active, context);
        if (task?.state.status === "terminal") {
          await main.commit(async (tx) => {
            await archiveWorker(tx, String(worker.id), worker.active!);
            for (const [id, run] of Object.entries((await tx.doc(OrchestrationDoc)).runs)) {
              if (run.taskId !== worker.active) continue;
              run.status = "failed";
              run.finishedAt = Date.now();
              Object.assign(await tx.doc(ArchivedRun, run.id, run), run);
              delete (await tx.doc(OrchestrationDoc)).runs[id];
            }
          }, context);
        } else if (task)
          result.push({
            sessionId: String(worker.id),
            conversationId: worker.id,
            workspaceId: worker.workspaceId,
            parentId: worker.parentId,
            prompt: worker.prompt,
            taskId: worker.active,
            startedAtMs: worker.startedAtMs ?? null,
          });
      }
      return result;
    },
    metadata(id: ConversationId) {
      return harness.snapshot(WorkerDoc, id, context);
    },
    listJobs,
    importJob,
    addJob,
    updateJob,
    removeJob,
    listRunningCron,
    listRunLogs,
    stopRunning,
    /** Exposed for deterministic host tests; admission is idempotent at each persisted due time. */
    tick,
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
    },
  };
}
export type Orchestration = ReturnType<typeof createOrchestration>;
