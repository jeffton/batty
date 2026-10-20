import { modelChange } from "./orchestration-worker-config.js";
import { archiveWorker, removeCompletedOneShot } from "./orchestration-lifecycle.js";
import { randomUUID } from "node:crypto";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";

import { buildCronRuntimeNotice } from "./runtime-notices.js";

import { ArchivedRun, indexRun, readRuns } from "./orchestration-history";

import {
  OrchestrationDoc,
  WorkerDoc,
  type CronDelivery,
  type CronJob,
  type CronJobInput,
  type CronRun,
  type Schedule,
  type RunChange,
  type OrchestrationServices,
} from "./orchestration-state.js";
import { normalizeSchedule, nextAt } from "./cron-schedule.js";
import type { createDeliveryTask } from "./orchestration-delivery.js";
import type { createWorkers } from "./orchestration-workers.js";

const context = BACKGROUND_CONTEXT;
function validateDelivery(delivery?: CronDelivery) {
  if (delivery !== undefined && !["direct", "assistant"].includes(delivery))
    throw new Error("Invalid cron delivery mode");
}

function jobTitle(title: string) {
  if (typeof title !== "string" || !title.trim()) throw new Error("Cron title is required");
  return title.trim();
}

function reply(text: string) {
  return { output: [{ type: "text" as const, text }] };
}

export function createCronScheduler(
  services: OrchestrationServices,
  Delivery: ReturnType<typeof createDeliveryTask>,
  workers: ReturnType<typeof createWorkers>,
  onError: (error: unknown) => void,
) {
  const { Anchor, createWorker } = workers;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const snapshot = async () => (await services.harness.snapshot(OrchestrationDoc, context))!;
  const listJobs = async (workspaceId?: string) =>
    Object.values((await snapshot()).jobs).filter(
      (j) => workspaceId === undefined || j.workspaceId === workspaceId,
    );
  const listJobSummaries = async (workspaceId?: string) =>
    (await listJobs(workspaceId)).map(
      ({ id, title, workspaceId, enabled, schedule, nextAt, retryAt }) => ({
        id,
        title,
        workspaceId,
        enabled,
        schedule,
        nextAt,
        retryAt,
      }),
    );
  const getJob = async (id: string) => {
    const job = (await snapshot()).jobs[id];
    if (!job) throw new Error(`Unknown cron job: ${id}`);
    return job;
  };
  const listRunLogs = async (jobId?: string, limit = 100, workspaceId?: string) =>
    readRuns(services.harness, context, jobId, limit, workspaceId);
  const listRunningCron = async (jobId?: string) => {
    const running: CronRun[] = [];
    for (const run of Object.values((await snapshot()).runs)) {
      const task = await services.harness.getTask(run.taskId, context);
      if (task?.state.status !== "terminal") {
        if (!jobId || run.jobId === jobId) running.push(run);
        continue;
      }
      const outcome = task.state.outcome;
      await services.main.commit(async (tx) => {
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
        const ws = await services.workspace(job.workspaceId);
        const agent = await services.main.agent(context);
        await services.main.commit(async (tx) => {
          const doc = await tx.doc(OrchestrationDoc);
          const current = doc.jobs[job.id];
          if (!current?.enabled || JSON.stringify(current) !== JSON.stringify(job)) return;
          const runId = `${job.id}:${job.nextAt}`;
          if (doc.runs[runId]) return;
          const anchor = await tx.createTask(Anchor, null, {
            ownership: { kind: "conversation" },
            background: true,
          });
          const child = await createWorker(
            tx,
            anchor,
            services.main.id,
            ws,
            job.prompt,
            agent,
            modelChange(job.model, job.thinkingLevel),
          );
          const metadata = await tx.doc(WorkerDoc, child);
          metadata.isCron = true;
          metadata.isSubagent = false;
          metadata.cronJobId = job.id;
          const taskId = await tx.createTask(
            Delivery,
            {
              workerId: String(child),
              childId: child,
              mainId: services.main.id,
              prompt: job.prompt,
              notice: {
                ...buildCronRuntimeNotice({
                  scheduleLabel: JSON.stringify(job.schedule),
                  prompt: job.prompt,
                  now: new Date(now),
                }),
                data: { cron: { workspaceId: ws.id, cwd: ws.path, runId } },
              },
              report: true,
              delivery: job.delivery ?? "assistant",
              runId,
              change: { ...modelChange(job.model, job.thinkingLevel), cwd: ws.path } as RunChange,
              workspaceId: ws.id,
            },
            { ownership: { kind: "conversation" }, background: true },
          );
          doc.workers[String(child)]!.active = taskId;
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
        services.harness.resume();
      } catch (error) {
        onError(error);
        await services.main.commit(async (tx) => {
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
    const title = jobTitle(input.title);
    validateDelivery(input.delivery);
    if (!input.prompt.trim()) throw new Error("Cron prompt is required");
    modelChange(input.model, input.thinkingLevel);
    const ws = await services.workspace(input.workspaceId);
    const now = Date.now();
    const schedule = normalizeSchedule(input.schedule, now);
    const job: CronJob = {
      title,
      id: randomUUID(),
      workspaceId: ws.id,
      enabled: input.enabled ?? true,
      prompt: input.prompt,
      schedule,
      delivery: input.delivery ?? "assistant",
      createdAt: now,
      updatedAt: now,
    };
    if (input.model) job.model = input.model;
    if (input.thinkingLevel) job.thinkingLevel = input.thinkingLevel;
    const next = nextAt(schedule, now);
    if (next !== undefined) job.nextAt = next;
    await services.main.commit(async (tx) => {
      (await tx.doc(OrchestrationDoc)).jobs[job.id] = job;
    }, context);
    await arm();
    return job;
  };
  const importJob = async (input: CronJob) => {
    const title = jobTitle(input.title);
    validateDelivery(input.delivery);
    if (!input.id || !input.prompt.trim()) throw new Error("Cron id and prompt are required");
    if (typeof input.enabled !== "boolean") throw new Error("Cron enabled must be boolean");
    if (!Number.isFinite(input.createdAt) || !Number.isFinite(input.updatedAt))
      throw new Error("Invalid cron timestamp");
    for (const value of [input.nextAt, input.retryAt]) {
      if (value !== undefined && !Number.isFinite(value)) throw new Error("Invalid cron timestamp");
    }
    modelChange(input.model, input.thinkingLevel);
    const ws = await services.workspace(input.workspaceId);
    let schedule: Schedule;
    if (input.schedule.kind === "at") {
      if (!Number.isFinite(Date.parse(input.schedule.at))) throw new Error("Invalid at schedule");
      schedule = { kind: "at", at: input.schedule.at };
    } else {
      schedule = normalizeSchedule(input.schedule, Date.now());
    }
    const job: CronJob = {
      title,
      id: input.id,
      workspaceId: ws.id,
      enabled: input.enabled,
      prompt: input.prompt,
      ...(input.delivery !== undefined ? { delivery: input.delivery } : {}),
      schedule,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    };
    if (input.model !== undefined) job.model = input.model;
    if (input.thinkingLevel !== undefined) job.thinkingLevel = input.thinkingLevel;
    if (input.nextAt !== undefined) job.nextAt = input.nextAt;
    if (input.retryAt !== undefined) job.retryAt = input.retryAt;
    await services.main.commit(async (tx) => {
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
    const title = input.title !== undefined ? jobTitle(input.title) : undefined;
    const ws = input.workspaceId ? await services.workspace(input.workspaceId) : undefined;
    const now = Date.now();
    const schedule = input.schedule ? normalizeSchedule(input.schedule, now) : undefined;
    const job = await services.main.commit(async (tx) => {
      const doc = await tx.doc(OrchestrationDoc);
      const job = doc.jobs[id];
      if (!job) throw new Error(`Unknown cron job: ${id}`);
      if (title !== undefined) job.title = title;
      if (input.prompt !== undefined) {
        if (!input.prompt.trim()) throw new Error("Cron prompt is required");
        job.prompt = input.prompt;
      }
      if (input.enabled !== undefined) job.enabled = input.enabled;
      if (input.model !== undefined) job.model = input.model;
      if (input.thinkingLevel !== undefined) job.thinkingLevel = input.thinkingLevel;
      if (input.delivery !== undefined) job.delivery = input.delivery;
      if (ws) job.workspaceId = ws.id;
      if (schedule) job.schedule = schedule;
      if (schedule || (input.enabled === true && job.nextAt === undefined))
        job.nextAt = nextAt(job.schedule, now);
      // Cosmetic renames must not mark an executing one-shot as edited for retirement.
      if (
        ["prompt", "enabled", "model", "thinkingLevel", "delivery", "workspaceId", "schedule"].some(
          (field) => input[field as keyof CronJobInput] !== undefined,
        )
      ) {
        job.updatedAt = now;
        delete job.retryAt;
      }
      return JSON.parse(JSON.stringify(job)) as CronJob;
    }, context);
    await arm();
    return job;
  };
  const removeJob = async (id: string) => {
    await services.main.commit(async (tx) => {
      const jobs = (await tx.doc(OrchestrationDoc)).jobs;
      if (!jobs[id]) throw new Error(`Unknown cron job: ${id}`);
      delete jobs[id];
    }, context);
    await arm();
  };
  const stopRunning = async (runId: string) => {
    const run =
      (await snapshot()).runs[runId] ??
      (await services.harness.snapshot(ArchivedRun, runId, context));
    if (!run) throw new Error(`Unknown cron run: ${runId}`);
    await services.harness.abortTask(run.taskId, context);
  };
  const cron = defineTool({
    name: "cron",
    description:
      "Manage scheduled tasks. add requires title, prompt and schedule; update accepts title. list returns compact summaries across all workspaces unless workspaceId filters them, without prompts; get requires jobId and returns full job details including prompt. Each run starts a fresh worker in the selected workspace. Workers in the assistant workspace receive main OptChat memory. delivery=assistant (default) lets the main assistant handle the result; delivery=direct shows the result unchanged to the user. Return NO_REPLY for no user-visible output.",
    replay: "unsafe",
    parameters: Type.Object({
      action: Type.String(),
      jobId: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
      runId: Type.Optional(Type.String()),
      workspaceId: Type.Optional(Type.String()),
      enabled: Type.Optional(Type.Boolean()),
      delivery: Type.Optional(Type.Union([Type.Literal("direct"), Type.Literal("assistant")])),
      prompt: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      thinkingLevel: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number()),
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
          result = await listJobSummaries(args.workspaceId);
          break;
        case "get":
          result = await getJob(args.jobId!);
          break;
        case "add":
          result = await addJob({
            ...args,
            workspaceId: (await services.workspace(args.workspaceId, api.conversationId)).id,
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
  return {
    cron,
    listJobs,
    listJobSummaries,
    getJob,
    listRunLogs,
    listRunningCron,
    addJob,
    importJob,
    updateJob,
    removeJob,
    stopRunning,
    tick,
    async start() {
      closed = false;
      await tick();
      await arm();
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
    },
  };
}
