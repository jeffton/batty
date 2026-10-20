import { archiveWorker, removeCompletedOneShot } from "./orchestration-lifecycle.js";
import { orchestrationHooks } from "./orchestration-hooks.js";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Message } from "@earendil-works/pi-ai";
import {
  LiveDoc,
  defineExtension,
  type Conversation,
  type ConversationId,
  type Harness,
} from "@earendil-works/pi-durable";

import type { AppConfig } from "./config.js";
import { listWorkspaces } from "./workspaces.js";

import { withoutMainMemory } from "./main-memory-policy.js";

import { ArchivedWorker, ArchivedRun, DeliveryRecord, indexRun } from "./orchestration-history";
import { conversationPolicy } from "./conversation-policy";

import {
  OrchestrationDoc,
  WorkerDoc,
  type OrchestrationConfig,
  type OrchestrationServices,
  type ContextProvider,
  type PrepareAgent,
  type WorkerBrowserLifecycle,
  type ContextMode,
} from "./orchestration-state.js";
import { createDeliveryTask } from "./orchestration-delivery.js";
import { createWorkers } from "./orchestration-workers.js";
import { createRemoteCommands } from "./remote-command.js";
import { createRemoteJoin } from "./remote-join.js";
import { createCronScheduler } from "./orchestration-cron.js";
export { OrchestrationDoc, WorkerDoc } from "./orchestration-state.js";
export type {
  ContextMode,
  ContextProvider,
  PrepareAgent,
  CronJobInput,
  CronJob,
  CronRun,
  ScheduleInput,
  CronSession,
  CronDelivery,
  OrchestrationConfig,
  WorkerBrowserLifecycle,
} from "./orchestration-state.js";
export { parseDuration } from "./cron-schedule.js";
const context = BACKGROUND_CONTEXT;
export function createOrchestration(input: OrchestrationConfig | AppConfig = {}) {
  const options: OrchestrationConfig =
    "workspacesRoots" in input ? { config: input, workspaces: () => listWorkspaces(input) } : input;
  let harness: Harness;
  let main: Conversation;
  let contextFor = options.contextFor;
  let prepareAgent = options.prepareAgent;
  let browserLifecycle: WorkerBrowserLifecycle | undefined;
  let remoteWorkers: import("./orchestration-state").RemoteWorkerService | undefined;
  const workspaceList = async () =>
    typeof options.workspaces === "function"
      ? await options.workspaces()
      : (options.workspaces ?? []);
  const assistantWorkspaceId = async () =>
    (await workspaceList()).find((workspace) => workspace.isAssistant)?.id;
  const preparedContext = async (
    parentId: ConversationId,
    mode: ContextMode,
    workspaceId: string,
  ): Promise<readonly Message[]> => {
    if (mode === false) return [];
    if (!contextFor)
      throw new Error("Context copying requires orchestration.setContextProvider(fn)");
    const copied = await contextFor(parentId, mode);
    const messages = conversationPolicy("worker", workspaceId, await assistantWorkspaceId())
      .mainMemory
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
  const onError = options.onError ?? console.error;
  const workspace = async (id?: string, parentId?: ConversationId) => {
    if (options.resolveWorkspace) return options.resolveWorkspace(id, parentId);
    const list = await workspaceList();
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
  const services: OrchestrationServices = {
    get remoteWorkers() {
      return remoteWorkers;
    },
    get harness() {
      return harness;
    },
    get main() {
      return main;
    },
    get prepareAgent() {
      return prepareAgent;
    },
    get browserLifecycle() {
      return browserLifecycle;
    },
    workspace,
    assistantWorkspaceId,
    preparedContext,
  };
  const Delivery = createDeliveryTask(services);
  const workers = createWorkers(services, Delivery);
  const { Anchor, AwaitChild, subagent } = workers;
  const nodeCommands = createRemoteCommands(workers.command, () => ({ harness, main }));
  const RemoteJoin = createRemoteJoin(services);
  const scheduler = createCronScheduler(services, Delivery, workers, onError);
  const {
    cron,
    listJobSummaries,
    getJob,
    listJobs,
    listRunLogs,
    listRunningCron,
    addJob,
    importJob,
    updateJob,
    removeJob,
    stopRunning,
    tick,
  } = scheduler;
  const snapshot = async () => (await harness.snapshot(OrchestrationDoc, context))!;
  const extension = defineExtension({
    name: "batty-orchestration",
    tools: [subagent, cron],
    tasks: [Anchor, AwaitChild, Delivery, nodeCommands.Command, RemoteJoin],
    hooks: orchestrationHooks(services),
  });
  return {
    extension,
    nodeCommand: nodeCommands.execute,
    queryWorkers: (args: import("./orchestration-workers").WorkerCommand) =>
      workers.query(args, context),
    remoteJoinTask: RemoteJoin,
    setRemoteWorkers(value: import("./orchestration-state").RemoteWorkerService) {
      remoteWorkers = value;
    },
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
      await scheduler.start();
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
    canStopWorker(workerId: string) {
      return workers.canStopWorker(workerId, context);
    },
    stopWorker(workerId: string) {
      return workers.stopWorker(workerId, context);
    },
    metadata(id: ConversationId) {
      return harness.snapshot(WorkerDoc, id, context);
    },
    listJobs,
    listJobSummaries,
    getJob,
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
      scheduler.close();
    },
  };
}
export type Orchestration = ReturnType<typeof createOrchestration>;
