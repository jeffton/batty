import fs from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { Cron } from "croner";
import { randomUUID } from "node:crypto";
import type {
  CreateCronJobInput,
  CronJob,
  CronRunLog,
  RunningCronJob,
  UpdateCronJobInput,
} from "@/shared/types";
import type { AppConfig } from "./config";
import {
  CronStore,
  compareCronJobsByNextRun,
  RECENT_CRON_RUN_LOG_LIMIT,
  toCronJob,
  type StoredCronJob,
} from "./cron-persistence";
import { nextEveryRunAtMs, nextRunAtMs } from "./cron-schedule";
import { markJobRunFailed, markJobRunSucceeded } from "./cron-state";

const WATCH_DEBOUNCE_MS = 150;

interface ScheduledHandle {
  stop(): void;
}

type ActiveCronRun = RunningCronJob & {
  abortController: AbortController;
  cancelledByOverlap: boolean;
};

export interface CronJobRunnerContext {
  runId: string;
  signal: AbortSignal;
  onSessionStarted(session: { sessionId: string; sessionPath: string }): void | Promise<void>;
}

export interface CronJobSkippedContext {
  runId: string;
  skippedAtMs: number;
  activeRun: RunningCronJob;
  reason: string;
}

export interface CronJobRunner {
  run(
    job: CronJob,
    context: CronJobRunnerContext,
  ): Promise<{ sessionId: string; sessionPath: string }>;
  onSkipped?(job: CronJob, context: CronJobSkippedContext): Promise<void>;
}

function toRunLog(run: ActiveCronRun, status: CronRunLog["status"]): CronRunLog {
  const { abortController: _abortController, cancelledByOverlap: _cancelled, ...publicRun } = run;
  return { ...publicRun, status };
}

function createEveryHandle(job: StoredCronJob, onTrigger: () => void): ScheduledHandle {
  if (job.schedule.kind !== "every") {
    throw new Error(`Expected every schedule for job ${job.id}`);
  }

  const everySchedule = job.schedule;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const scheduleNext = () => {
    if (stopped) {
      return;
    }

    const nextAtMs = nextEveryRunAtMs(everySchedule);
    const delayMs = Math.max(0, nextAtMs - Date.now());

    timer = setTimeout(() => {
      timer = undefined;
      if (stopped) {
        return;
      }
      onTrigger();
      scheduleNext();
    }, delayMs);
    timer.unref?.();
  };

  scheduleNext();

  return {
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}

export class CronService {
  private readonly store: CronStore;
  private readonly scheduledHandles = new Map<string, ScheduledHandle>();
  private readonly jobs = new Map<string, StoredCronJob>();
  private readonly runningJobs = new Map<string, ActiveCronRun>();
  private runLogs: CronRunLog[] = [];
  private readonly changeListeners = new Set<(workspaceIds: string[]) => void>();
  private runner: CronJobRunner | undefined;
  private watcher: FSWatcher | undefined;
  private reloadTimer: NodeJS.Timeout | undefined;

  constructor(config: AppConfig) {
    this.store = new CronStore(config);
  }

  setRunner(runner: CronJobRunner): void {
    this.runner = runner;
  }

  subscribe(listener: (workspaceIds: string[]) => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  async initialize(): Promise<void> {
    await this.reloadFromDisk();
    const interruptedAtMs = Date.now();
    for (const run of this.runLogs.filter((candidate) => candidate.status === "running")) {
      await this.updateRunLog(run.runId, {
        status: "error",
        completedAtMs: interruptedAtMs,
        durationMs: Math.max(0, interruptedAtMs - run.startedAtMs),
        error: "Batty stopped before this cron run completed",
      });
    }
    await fs.mkdir(path.dirname(this.store.filePath), { recursive: true });
    this.watcher = watch(path.dirname(this.store.filePath), (_eventType, fileName) => {
      if (fileName && fileName !== path.basename(this.store.filePath)) {
        return;
      }
      clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => {
        void this.reloadFromDisk().catch((error) => {
          console.error("Failed to reload cron jobs", error);
        });
      }, WATCH_DEBOUNCE_MS);
      this.reloadTimer.unref?.();
    });
  }

  async dispose(): Promise<void> {
    clearTimeout(this.reloadTimer);
    this.reloadTimer = undefined;
    this.watcher?.close();
    this.watcher = undefined;
    for (const handle of this.scheduledHandles.values()) {
      handle.stop();
    }
    this.scheduledHandles.clear();
  }

  listJobs(workspaceId?: string): CronJob[] {
    return [...this.jobs.values()]
      .filter((job) => (workspaceId ? job.workspaceId === workspaceId : true))
      .map(toCronJob)
      .sort(compareCronJobsByNextRun);
  }

  listRunningJobs(workspaceId?: string): RunningCronJob[] {
    return [...this.runningJobs.values()]
      .filter((run) => (workspaceId ? run.workspaceId === workspaceId : true))
      .map(({ abortController: _abortController, cancelledByOverlap: _cancelled, ...run }) => run)
      .sort((a, b) => a.startedAtMs - b.startedAtMs);
  }

  listRecentRunLogs(workspaceId?: string, limit = RECENT_CRON_RUN_LOG_LIMIT): CronRunLog[] {
    return this.runLogs
      .filter((run) => (workspaceId ? run.workspaceId === workspaceId : true))
      .slice(0, Math.max(0, Math.min(limit, this.runLogs.length)));
  }

  stopRunningJob(selector: { runId?: string; jobId?: string }): RunningCronJob {
    const entry = [...this.runningJobs.values()].find(
      (run) =>
        (selector.runId ? run.runId === selector.runId : true) &&
        (selector.jobId ? run.jobId === selector.jobId : true),
    );
    if (!entry) {
      throw new Error(`Unknown running cron job: ${selector.runId ?? selector.jobId ?? ""}`);
    }

    entry.abortController.abort();
    const { abortController: _abortController, cancelledByOverlap: _cancelled, ...run } = entry;
    return run;
  }

  async createJob(input: CreateCronJobInput): Promise<CronJob> {
    const created = await this.store.createJob(input);
    await this.reloadFromDisk();
    return created;
  }

  async updateJob(jobId: string, patch: UpdateCronJobInput): Promise<CronJob> {
    const updated = await this.store.updateJob(jobId, patch);
    await this.reloadFromDisk();
    return updated;
  }

  async deleteJob(jobId: string): Promise<CronJob> {
    const deleted = await this.store.deleteJob(jobId);
    await this.reloadFromDisk();
    return deleted;
  }

  private notifyChanged(workspaceIds: string[]): void {
    if (workspaceIds.length === 0) {
      return;
    }
    for (const listener of this.changeListeners) {
      listener(workspaceIds);
    }
  }

  private replaceRunLog(run: CronRunLog): void {
    const index = this.runLogs.findIndex((candidate) => candidate.runId === run.runId);
    if (index < 0) {
      this.runLogs.push(run);
    } else {
      this.runLogs[index] = run;
    }
    this.runLogs = this.runLogs
      .sort((left, right) => {
        if (left.status === "running" && right.status !== "running") return -1;
        if (left.status !== "running" && right.status === "running") return 1;
        return right.startedAtMs - left.startedAtMs;
      })
      .slice(0, RECENT_CRON_RUN_LOG_LIMIT);
  }

  private async updateRunLog(runId: string, patch: Partial<CronRunLog>): Promise<void> {
    const updated = await this.store.updateRun(runId, patch);
    if (updated) {
      this.replaceRunLog(updated);
    }
  }

  private async reloadFromDisk(): Promise<void> {
    const previousWorkspaceIds = new Set([...this.jobs.values()].map((job) => job.workspaceId));
    const [jobs, runLogs] = await Promise.all([
      this.store.readStoredJobs(),
      this.store.readStoredRunLogs(),
    ]);
    this.runLogs = runLogs;
    this.jobs.clear();
    for (const job of jobs) {
      this.jobs.set(job.id, job);
      previousWorkspaceIds.add(job.workspaceId);
    }
    this.rescheduleAll();
    this.notifyChanged([...previousWorkspaceIds]);
  }

  private rescheduleAll(): void {
    for (const handle of this.scheduledHandles.values()) {
      handle.stop();
    }
    this.scheduledHandles.clear();

    for (const job of this.jobs.values()) {
      if (!job.enabled) {
        continue;
      }

      const nextAtMs = nextRunAtMs(job.schedule);
      if (nextAtMs == null) {
        if (job.schedule.kind === "at") {
          void this.triggerJob(job.id).catch((error) => {
            console.error("Failed to trigger overdue at job", { jobId: job.id, error });
          });
        }
        continue;
      }

      switch (job.schedule.kind) {
        case "at": {
          const cron = new Cron(job.schedule.at, { maxRuns: 1 }, () => {
            void this.triggerJob(job.id).catch((error) => {
              console.error("Failed to trigger at job", { jobId: job.id, error });
            });
          });
          this.scheduledHandles.set(job.id, {
            stop() {
              cron.stop();
            },
          });
          break;
        }
        case "every":
          this.scheduledHandles.set(
            job.id,
            createEveryHandle(job, () => {
              void this.triggerJob(job.id).catch((error) => {
                console.error("Failed to trigger interval job", { jobId: job.id, error });
              });
            }),
          );
          break;
        case "cron": {
          const cron = new Cron(
            job.schedule.expression,
            {
              timezone: job.schedule.timezone,
              protect: true,
            },
            () => {
              void this.triggerJob(job.id).catch((error) => {
                console.error("Failed to trigger cron job", { jobId: job.id, error });
              });
            },
          );
          this.scheduledHandles.set(job.id, {
            stop() {
              cron.stop();
            },
          });
          break;
        }
      }
    }
  }

  private async skipOverlappingRun(job: StoredCronJob, activeRun: ActiveCronRun): Promise<void> {
    const skippedAtMs = Date.now();
    const runId = `skipped-${skippedAtMs}-${randomUUID()}`;
    const reason = `Cron job skipped because previous run is still active: ${activeRun.runId}`;
    const publicJob = toCronJob(job);
    const skippedLog: CronRunLog = {
      runId,
      jobId: job.id,
      workspaceId: job.workspaceId,
      prompt: job.prompt,
      model: job.model,
      thinkingLevel: job.thinkingLevel,
      session: publicJob.session,
      scheduleLabel: publicJob.scheduleLabel,
      startedAtMs: skippedAtMs,
      status: "error",
      completedAtMs: skippedAtMs,
      durationMs: 0,
      error: reason,
    };
    await this.store.startRun(skippedLog);
    this.replaceRunLog(skippedLog);
    console.warn(reason, { jobId: job.id, activeRunId: activeRun.runId });
    activeRun.cancelledByOverlap = true;
    activeRun.abortController.abort();

    if (job.schedule.kind !== "at") {
      await this.store.setJobState(job.id, markJobRunFailed(job.state, skippedAtMs, reason));
      await this.reloadFromDisk();
    }

    await this.runner?.onSkipped?.(toCronJob(job), {
      runId,
      skippedAtMs,
      activeRun,
      reason,
    });
    this.notifyChanged([job.workspaceId]);
  }

  private async triggerJob(jobId: string): Promise<void> {
    const current = this.jobs.get(jobId);
    if (!current?.enabled) {
      return;
    }

    const activeRun = [...this.runningJobs.values()].find((run) => run.jobId === jobId);
    if (activeRun) {
      await this.skipOverlappingRun(current, activeRun);
      return;
    }

    const startedAt = Date.now();
    const publicJob = toCronJob(current);
    const abortController = new AbortController();
    const running: ActiveCronRun = {
      runId: randomUUID(),
      jobId,
      workspaceId: current.workspaceId,
      prompt: current.prompt,
      model: current.model,
      thinkingLevel: current.thinkingLevel,
      session: publicJob.session,
      scheduleLabel: publicJob.scheduleLabel,
      startedAtMs: startedAt,
      abortController,
      cancelledByOverlap: false,
    };
    this.runningJobs.set(running.runId, running);
    let runLogPersisted = false;

    try {
      const startedLog = toRunLog(running, "running");
      await this.store.startRun(startedLog);
      runLogPersisted = true;
      this.replaceRunLog(startedLog);
      this.notifyChanged([current.workspaceId]);
      if (current.schedule.kind === "at") {
        await this.store.deleteJob(jobId);
        await this.reloadFromDisk();
      }

      if (!this.runner) {
        throw new Error("Cron runner not configured");
      }

      const result = await this.runner.run(publicJob, {
        runId: running.runId,
        signal: abortController.signal,
        onSessionStarted: async (session) => {
          running.sessionId = session.sessionId;
          running.sessionPath = session.sessionPath;
          await this.updateRunLog(running.runId, {
            sessionId: session.sessionId,
            sessionPath: session.sessionPath,
          });
          this.notifyChanged([running.workspaceId]);
        },
      });
      await this.updateRunLog(running.runId, {
        status: running.cancelledByOverlap ? "error" : "success",
        completedAtMs: Date.now(),
        durationMs: Date.now() - startedAt,
        sessionId: result.sessionId,
        sessionPath: result.sessionPath,
        error: running.cancelledByOverlap
          ? "Cron run cancelled because a newer run started"
          : undefined,
      });
      if (
        this.runningJobs.get(running.runId) === running &&
        !running.cancelledByOverlap &&
        current.schedule.kind !== "at"
      ) {
        await this.store.setJobState(jobId, markJobRunSucceeded(current.state, startedAt, result));
        await this.reloadFromDisk();
      }
    } catch (error) {
      console.error("Cron job failed", { jobId, error });
      if (runLogPersisted) {
        await this.updateRunLog(running.runId, {
          status: "error",
          completedAtMs: Date.now(),
          durationMs: Date.now() - startedAt,
          sessionId: running.sessionId,
          sessionPath: running.sessionPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (
        this.runningJobs.get(running.runId) === running &&
        !running.cancelledByOverlap &&
        current.schedule.kind !== "at"
      ) {
        await this.store.setJobState(jobId, markJobRunFailed(current.state, startedAt, error));
        await this.reloadFromDisk();
      }
    } finally {
      if (this.runningJobs.get(running.runId) === running) {
        this.runningJobs.delete(running.runId);
      }
      this.notifyChanged([current.workspaceId]);
    }
  }
}
