import fs from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { Cron } from "croner";
import type { CreateCronJobInput, CronJob, UpdateCronJobInput } from "@/shared/types";
import type { AppConfig } from "./config";
import {
  CronStore,
  compareCronJobsByNextRun,
  toCronJob,
  type StoredCronJob,
} from "./cron-persistence";
import { nextEveryRunAtMs, nextRunAtMs } from "./cron-schedule";
import { markJobRunFailed, markJobRunSucceeded } from "./cron-state";

const WATCH_DEBOUNCE_MS = 150;
const WATCH_IGNORE_MS = 500;

interface ScheduledHandle {
  stop(): void;
}

export interface CronJobRunner {
  run(job: CronJob): Promise<{ sessionId: string; sessionPath: string }>;
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
  private readonly runningJobs = new Set<string>();
  private readonly changeListeners = new Set<(workspaceIds: string[]) => void>();
  private runner: CronJobRunner | undefined;
  private watcher: FSWatcher | undefined;
  private reloadTimer: NodeJS.Timeout | undefined;
  private ignoreWatchEventsUntil = 0;

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
    await fs.mkdir(path.dirname(this.store.filePath), { recursive: true });
    this.watcher = watch(path.dirname(this.store.filePath), (_eventType, fileName) => {
      if (Date.now() < this.ignoreWatchEventsUntil) {
        return;
      }
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

  async createJob(input: CreateCronJobInput): Promise<CronJob> {
    this.ignoreOwnWatchEvents();
    const created = await this.store.createJob(input);
    await this.reloadFromDisk();
    return created;
  }

  async updateJob(jobId: string, patch: UpdateCronJobInput): Promise<CronJob> {
    this.ignoreOwnWatchEvents();
    const updated = await this.store.updateJob(jobId, patch);
    await this.reloadFromDisk();
    return updated;
  }

  async deleteJob(jobId: string): Promise<CronJob> {
    this.ignoreOwnWatchEvents();
    const deleted = await this.store.deleteJob(jobId);
    await this.reloadFromDisk();
    return deleted;
  }

  private ignoreOwnWatchEvents(): void {
    this.ignoreWatchEventsUntil = Date.now() + WATCH_IGNORE_MS;
  }

  private notifyChanged(workspaceIds: string[]): void {
    if (workspaceIds.length === 0) {
      return;
    }
    for (const listener of this.changeListeners) {
      listener(workspaceIds);
    }
  }

  private async reloadFromDisk(): Promise<void> {
    const previousWorkspaceIds = new Set([...this.jobs.values()].map((job) => job.workspaceId));
    const jobs = await this.store.readStoredJobs();
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

  private async triggerJob(jobId: string): Promise<void> {
    const current = this.jobs.get(jobId);
    if (!current) {
      return;
    }

    if (this.runningJobs.has(jobId)) {
      console.warn("Cron job trigger skipped because a previous run is still active", { jobId });
      return;
    }

    this.runningJobs.add(jobId);
    const startedAt = Date.now();
    const publicJob = toCronJob(current);

    try {
      if (current.schedule.kind === "at") {
        this.ignoreOwnWatchEvents();
        await this.store.deleteJob(jobId);
        await this.reloadFromDisk();
      }

      if (!this.runner) {
        throw new Error("Cron runner not configured");
      }

      const result = await this.runner.run(publicJob);
      if (current.schedule.kind !== "at") {
        this.ignoreOwnWatchEvents();
        await this.store.setJobState(jobId, markJobRunSucceeded(current.state, startedAt, result));
        await this.reloadFromDisk();
      }
    } catch (error) {
      console.error("Cron job failed", { jobId, error });
      if (current.schedule.kind !== "at") {
        this.ignoreOwnWatchEvents();
        await this.store.setJobState(jobId, markJobRunFailed(current.state, startedAt, error));
        await this.reloadFromDisk();
      }
    } finally {
      this.runningJobs.delete(jobId);
    }
  }
}
