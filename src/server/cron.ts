import fs from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import type {
  CreateCronJobInput,
  CronJob,
  CronJobSchedule,
  CronJobScheduleInput,
  CronJobState,
  UpdateCronJobInput,
} from "@/shared/types";
import type { AppConfig } from "./config";
import { listWorkspaces } from "./workspaces";

const CRON_STORE_VERSION = 1;
const WATCH_DEBOUNCE_MS = 150;
const WATCH_IGNORE_MS = 500;
const DEFAULT_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

interface StoredCronJobEverySchedule {
  kind: "every";
  every: string;
  everyMs: number;
  anchorAtMs: number;
}

interface StoredCronJobAtSchedule {
  kind: "at";
  at: string;
}

interface StoredCronJobCronSchedule {
  kind: "cron";
  expression: string;
  timezone: string;
}

type StoredCronJobSchedule =
  | StoredCronJobAtSchedule
  | StoredCronJobEverySchedule
  | StoredCronJobCronSchedule;

interface StoredCronJob {
  id: string;
  workspaceId: string;
  prompt: string;
  model: string;
  thinkingLevel: string;
  createdAt: number;
  updatedAt: number;
  schedule: StoredCronJobSchedule;
  state: CronJobState;
}

interface PersistedCronStore {
  version: number;
  jobs: StoredCronJob[];
}

interface ScheduledHandle {
  stop(): void;
}

export interface CronJobRunner {
  run(job: CronJob): Promise<{ sessionId: string }>;
}

function createHttpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function normalizeNonEmptyString(value: string | undefined, field: string): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) {
    throw createHttpError(400, `${field} is required`);
  }
  return normalized;
}

function normalizeThinkingLevel(value: string | undefined): string {
  const thinkingLevel = normalizeNonEmptyString(value, "Thinking level").toLowerCase();
  if (!THINKING_LEVELS.has(thinkingLevel)) {
    throw createHttpError(
      400,
      `Invalid thinking level: ${thinkingLevel}. Expected one of ${[...THINKING_LEVELS].join(", ")}.`,
    );
  }
  return thinkingLevel;
}

function isDurationString(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith("+") || normalized.startsWith("in ") || /\d/.test(normalized);
}

function parseDurationMs(value: string): number {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^in\s+/, "")
    .replace(/^\+/, "");
  const matcher = /([0-9]+(?:\.[0-9]+)?)\s*(ms|s|m|h|d|w)/g;
  let total = 0;

  for (const match of normalized.matchAll(matcher)) {
    const amount = Number(match[1]);
    const unit = match[2];
    if (!Number.isFinite(amount) || amount <= 0) {
      throw createHttpError(400, `Invalid duration: ${value}`);
    }

    const multiplier =
      unit === "ms"
        ? 1
        : unit === "s"
          ? 1000
          : unit === "m"
            ? 60 * 1000
            : unit === "h"
              ? 60 * 60 * 1000
              : unit === "d"
                ? 24 * 60 * 60 * 1000
                : 7 * 24 * 60 * 60 * 1000;

    total += amount * multiplier;
  }

  const compact = normalized.replace(/\s+/g, "");
  const matched = [...compact.matchAll(/([0-9]+(?:\.[0-9]+)?)(ms|s|m|h|d|w)/g)]
    .map((match) => match[0])
    .join("");

  if (!matched || matched.length !== compact.length || !Number.isFinite(total) || total <= 0) {
    throw createHttpError(
      400,
      `Invalid duration: ${value}. Use values like 10m, 2h, 1d, or 1h30m.`,
    );
  }

  return Math.round(total);
}

function normalizeAtInput(
  input: Extract<CronJobScheduleInput, { kind: "at" }>,
  now: number,
): string {
  const relative = input.in?.trim();
  if (relative) {
    return new Date(now + parseDurationMs(relative)).toISOString();
  }

  const rawAt = input.at?.trim();
  if (!rawAt) {
    throw createHttpError(
      400,
      'Schedule "at" requires either an "at" timestamp or an "in" duration.',
    );
  }

  if (isDurationString(rawAt) && /^(?:\+|in\s+)/i.test(rawAt)) {
    return new Date(now + parseDurationMs(rawAt)).toISOString();
  }

  const date = new Date(rawAt);
  if (!Number.isFinite(date.getTime())) {
    throw createHttpError(
      400,
      `Invalid at schedule: ${rawAt}. Use an ISO timestamp or an in duration like 10m.`,
    );
  }
  if (date.getTime() <= now) {
    throw createHttpError(400, `At schedule must be in the future: ${rawAt}`);
  }

  return date.toISOString();
}

function normalizeSchedule(input: CronJobScheduleInput, now = Date.now()): StoredCronJobSchedule {
  switch (input.kind) {
    case "at":
      return {
        kind: "at",
        at: normalizeAtInput(input, now),
      };
    case "every": {
      const every = normalizeNonEmptyString(input.every, "Every schedule");
      return {
        kind: "every",
        every,
        everyMs: parseDurationMs(every),
        anchorAtMs: now,
      };
    }
    case "cron":
      return {
        kind: "cron",
        expression: normalizeNonEmptyString(input.expression, "Cron expression"),
        timezone: input.timezone?.trim() || DEFAULT_TIMEZONE,
      };
    default:
      throw createHttpError(400, "Invalid schedule kind");
  }
}

function toPublicSchedule(schedule: StoredCronJobSchedule): CronJobSchedule {
  switch (schedule.kind) {
    case "at":
      return { kind: "at", at: schedule.at };
    case "every":
      return { kind: "every", every: schedule.every };
    case "cron":
      return {
        kind: "cron",
        expression: schedule.expression,
        timezone: schedule.timezone,
      };
  }
}

function formatScheduleLabel(schedule: StoredCronJobSchedule): string {
  switch (schedule.kind) {
    case "at":
      return `At ${schedule.at}`;
    case "every":
      return `Every ${schedule.every}`;
    case "cron":
      return `Cron ${schedule.expression} · ${schedule.timezone}`;
  }
}

function nextEveryRunAtMs(schedule: StoredCronJobEverySchedule, now = Date.now()): number {
  if (schedule.anchorAtMs > now) {
    return schedule.anchorAtMs;
  }

  const elapsed = Math.max(0, now - schedule.anchorAtMs);
  const intervalsElapsed = Math.floor(elapsed / schedule.everyMs);
  const candidate = schedule.anchorAtMs + (intervalsElapsed + 1) * schedule.everyMs;
  return candidate > now ? candidate : candidate + schedule.everyMs;
}

function nextRunAtMs(schedule: StoredCronJobSchedule, now = Date.now()): number | undefined {
  switch (schedule.kind) {
    case "at": {
      const atMs = new Date(schedule.at).getTime();
      return atMs > now ? atMs : undefined;
    }
    case "every":
      return nextEveryRunAtMs(schedule, now);
    case "cron": {
      const next = new Cron(schedule.expression, {
        timezone: schedule.timezone,
        paused: true,
      }).nextRun();
      return next ? next.getTime() : undefined;
    }
  }
}

function toCronJob(job: StoredCronJob): CronJob {
  return {
    id: job.id,
    workspaceId: job.workspaceId,
    prompt: job.prompt,
    model: job.model,
    thinkingLevel: job.thinkingLevel,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    schedule: toPublicSchedule(job.schedule),
    scheduleLabel: formatScheduleLabel(job.schedule),
    state: {
      ...job.state,
      nextRunAtMs: nextRunAtMs(job.schedule),
    },
  };
}

function compareCronJobsByNextRun(left: CronJob, right: CronJob): number {
  if (left.state.nextRunAtMs == null && right.state.nextRunAtMs == null) {
    return left.createdAt - right.createdAt;
  }
  if (left.state.nextRunAtMs == null) {
    return 1;
  }
  if (right.state.nextRunAtMs == null) {
    return -1;
  }
  return left.state.nextRunAtMs - right.state.nextRunAtMs;
}

function normalizeState(value: unknown): CronJobState {
  const candidate = value && typeof value === "object" ? (value as Partial<CronJobState>) : {};
  return {
    nextRunAtMs:
      typeof candidate.nextRunAtMs === "number" && Number.isFinite(candidate.nextRunAtMs)
        ? candidate.nextRunAtMs
        : undefined,
    lastRunAtMs:
      typeof candidate.lastRunAtMs === "number" && Number.isFinite(candidate.lastRunAtMs)
        ? candidate.lastRunAtMs
        : undefined,
    lastDurationMs:
      typeof candidate.lastDurationMs === "number" && Number.isFinite(candidate.lastDurationMs)
        ? candidate.lastDurationMs
        : undefined,
    lastStatus:
      candidate.lastStatus === "ok" || candidate.lastStatus === "error"
        ? candidate.lastStatus
        : undefined,
    lastError:
      typeof candidate.lastError === "string" && candidate.lastError.length > 0
        ? candidate.lastError
        : undefined,
    lastSessionId:
      typeof candidate.lastSessionId === "string" && candidate.lastSessionId.length > 0
        ? candidate.lastSessionId
        : undefined,
  };
}

function normalizeStoredSchedule(value: unknown): StoredCronJobSchedule {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid cron schedule");
  }

  const schedule = value as Partial<StoredCronJobSchedule>;
  if (schedule.kind === "at") {
    return {
      kind: "at",
      at: normalizeAtInput({ kind: "at", at: schedule.at }, 0),
    };
  }

  if (schedule.kind === "every") {
    const every = normalizeNonEmptyString(schedule.every, "Every schedule");
    const everyMs =
      typeof schedule.everyMs === "number" && Number.isFinite(schedule.everyMs)
        ? schedule.everyMs
        : parseDurationMs(every);
    const anchorAtMs =
      typeof schedule.anchorAtMs === "number" && Number.isFinite(schedule.anchorAtMs)
        ? schedule.anchorAtMs
        : Date.now();

    return {
      kind: "every",
      every,
      everyMs,
      anchorAtMs,
    };
  }

  if (schedule.kind === "cron") {
    const expression = normalizeNonEmptyString(schedule.expression, "Cron expression");
    const timezone = schedule.timezone?.trim() || DEFAULT_TIMEZONE;
    new Cron(expression, { timezone, paused: true });
    return {
      kind: "cron",
      expression,
      timezone,
    };
  }

  throw new Error("Invalid cron schedule kind");
}

function normalizeStoredJob(value: unknown): StoredCronJob {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid cron job");
  }

  const job = value as Partial<StoredCronJob>;
  return {
    id: normalizeNonEmptyString(job.id, "Job id"),
    workspaceId: normalizeNonEmptyString(job.workspaceId, "Workspace"),
    prompt: normalizeNonEmptyString(job.prompt, "Prompt"),
    model: normalizeNonEmptyString(job.model, "Model"),
    thinkingLevel: normalizeThinkingLevel(job.thinkingLevel),
    createdAt:
      typeof job.createdAt === "number" && Number.isFinite(job.createdAt)
        ? job.createdAt
        : Date.now(),
    updatedAt:
      typeof job.updatedAt === "number" && Number.isFinite(job.updatedAt)
        ? job.updatedAt
        : Date.now(),
    schedule: normalizeStoredSchedule(job.schedule),
    state: normalizeState(job.state),
  };
}

export function cronJobsFilePath(battyDir: string): string {
  return path.join(battyDir, ".batty", "cron", "jobs.json");
}

export class CronStore {
  readonly filePath: string;

  constructor(private readonly config: AppConfig) {
    this.filePath = cronJobsFilePath(config.battyDir);
  }

  async listJobs(workspaceId?: string): Promise<CronJob[]> {
    const jobs = await this.readStoredJobs();
    return jobs
      .filter((job) => (workspaceId ? job.workspaceId === workspaceId : true))
      .map(toCronJob)
      .sort(compareCronJobsByNextRun);
  }

  async readStoredJobs(): Promise<StoredCronJob[]> {
    const persisted = await this.readStore();
    return persisted.jobs.map(normalizeStoredJob);
  }

  async createJob(input: CreateCronJobInput): Promise<CronJob> {
    const workspaceId = normalizeNonEmptyString(input.workspaceId, "Workspace");
    await this.requireWorkspace(workspaceId);

    const now = Date.now();
    const job: StoredCronJob = {
      id: randomUUID(),
      workspaceId,
      prompt: normalizeNonEmptyString(input.prompt, "Prompt"),
      model: normalizeNonEmptyString(input.model, "Model"),
      thinkingLevel: normalizeThinkingLevel(input.thinkingLevel),
      createdAt: now,
      updatedAt: now,
      schedule: normalizeSchedule(input.schedule, now),
      state: {},
    };

    const jobs = await this.readStoredJobs();
    jobs.push(job);
    await this.writeStore(jobs);
    return toCronJob(job);
  }

  async updateJob(jobId: string, patch: UpdateCronJobInput): Promise<CronJob> {
    const jobs = await this.readStoredJobs();
    const index = jobs.findIndex((job) => job.id === jobId);
    if (index < 0) {
      throw createHttpError(404, `Unknown cron job: ${jobId}`);
    }

    const current = jobs[index];
    const workspaceId =
      typeof patch.workspaceId === "string"
        ? normalizeNonEmptyString(patch.workspaceId, "Workspace")
        : current.workspaceId;
    await this.requireWorkspace(workspaceId);

    const updatedAt = Date.now();
    const next: StoredCronJob = {
      ...current,
      workspaceId,
      prompt:
        patch.prompt == null ? current.prompt : normalizeNonEmptyString(patch.prompt, "Prompt"),
      model: patch.model == null ? current.model : normalizeNonEmptyString(patch.model, "Model"),
      thinkingLevel:
        patch.thinkingLevel == null
          ? current.thinkingLevel
          : normalizeThinkingLevel(patch.thinkingLevel),
      updatedAt,
      schedule: patch.schedule ? normalizeSchedule(patch.schedule, updatedAt) : current.schedule,
    };

    jobs[index] = next;
    await this.writeStore(jobs);
    return toCronJob(next);
  }

  async deleteJob(jobId: string): Promise<CronJob> {
    const jobs = await this.readStoredJobs();
    const job = jobs.find((candidate) => candidate.id === jobId);
    if (!job) {
      throw createHttpError(404, `Unknown cron job: ${jobId}`);
    }

    await this.writeStore(jobs.filter((candidate) => candidate.id !== jobId));
    return toCronJob(job);
  }

  async setJobState(jobId: string, state: Partial<CronJobState>): Promise<CronJob | undefined> {
    const jobs = await this.readStoredJobs();
    const index = jobs.findIndex((job) => job.id === jobId);
    if (index < 0) {
      return undefined;
    }

    const current = jobs[index];
    const next: StoredCronJob = {
      ...current,
      updatedAt: Date.now(),
      state: {
        ...current.state,
        ...state,
      },
    };

    jobs[index] = next;
    await this.writeStore(jobs);
    return toCronJob(next);
  }

  private async requireWorkspace(workspaceId: string): Promise<void> {
    const workspaces = await listWorkspaces(this.config);
    if (!workspaces.some((workspace) => workspace.id === workspaceId)) {
      throw createHttpError(404, `Unknown workspace: ${workspaceId}`);
    }
  }

  private async readStore(): Promise<PersistedCronStore> {
    try {
      const content = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content) as PersistedCronStore;
      const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
      return {
        version: parsed.version,
        jobs,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: CRON_STORE_VERSION, jobs: [] };
      }
      throw error;
    }
  }

  private async writeStore(jobs: StoredCronJob[]): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const payload: PersistedCronStore = {
      version: CRON_STORE_VERSION,
      jobs,
    };
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await fs.rename(tempPath, this.filePath);
  }
}

function createEveryHandle(job: StoredCronJob, onTrigger: () => void): ScheduledHandle {
  if (job.schedule.kind !== "every") {
    throw new Error(`Expected every schedule for job ${job.id}`);
  }

  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const scheduleNext = () => {
    if (stopped) {
      return;
    }

    const nextAtMs = nextEveryRunAtMs(job.schedule);
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
  private runner?: CronJobRunner;
  private watcher?: FSWatcher;
  private reloadTimer?: NodeJS.Timeout;
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
        await this.store.setJobState(jobId, {
          lastRunAtMs: startedAt,
          lastDurationMs: Date.now() - startedAt,
          lastStatus: "ok",
          lastError: undefined,
          lastSessionId: result.sessionId,
        });
        await this.reloadFromDisk();
      }
    } catch (error) {
      console.error("Cron job failed", { jobId, error });
      if (current.schedule.kind !== "at") {
        this.ignoreOwnWatchEvents();
        await this.store.setJobState(jobId, {
          lastRunAtMs: startedAt,
          lastDurationMs: Date.now() - startedAt,
          lastStatus: "error",
          lastError: error instanceof Error ? error.message : String(error),
        });
        await this.reloadFromDisk();
      }
    } finally {
      this.runningJobs.delete(jobId);
    }
  }
}

export function buildCronJobSummary(job: CronJob): string {
  const lines = [
    `Job: ${job.id}`,
    `Workspace: ${job.workspaceId}`,
    `Schedule: ${job.scheduleLabel}`,
    `Model: ${job.model}`,
    `Thinking: ${job.thinkingLevel}`,
    `Prompt: ${job.prompt}`,
  ];

  if (job.state.nextRunAtMs) {
    lines.push(`Next run: ${new Date(job.state.nextRunAtMs).toISOString()}`);
  }
  if (job.state.lastRunAtMs) {
    lines.push(`Last run: ${new Date(job.state.lastRunAtMs).toISOString()}`);
  }
  if (job.state.lastStatus) {
    lines.push(`Last status: ${job.state.lastStatus}`);
  }
  if (job.state.lastError) {
    lines.push(`Last error: ${job.state.lastError}`);
  }

  return lines.join("\n");
}
