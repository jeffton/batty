import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import type {
  CreateCronJobInput,
  CronJob,
  CronJobState,
  CronRunLog,
  UpdateCronJobInput,
} from "@/shared/types";
import type { AppConfig } from "./config";
import { createHttpError, normalizeNonEmptyString } from "./cron-http";
import {
  formatScheduleLabel,
  nextRunAtMs,
  normalizeSchedule,
  normalizeStoredSchedule,
  toPublicSchedule,
  type StoredCronJobSchedule,
} from "./cron-schedule";
import {
  normalizeSession,
  normalizeState,
  normalizeStoredSession,
  normalizeStoredThinkingLevel,
  normalizeThinkingLevel,
  toPublicSession,
  type StoredCronJobSession,
} from "./cron-state";
import { listWorkspaces } from "./workspaces";

const CRON_STORE_VERSION = 2;
export const RECENT_CRON_RUN_LOG_LIMIT = 100;

export interface StoredCronJob {
  id: string;
  workspaceId: string;
  enabled: boolean;
  prompt: string;
  model: string;
  thinkingLevel: string;
  session: StoredCronJobSession;
  createdAt: number;
  updatedAt: number;
  schedule: StoredCronJobSchedule;
  state: CronJobState;
}

interface PersistedCronStore {
  version: typeof CRON_STORE_VERSION;
  jobs: StoredCronJob[];
  runs: CronRunLog[];
}

interface RawPersistedCronStore {
  version: number;
  jobs: unknown[];
  runs?: unknown[];
}

function requireStoredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`Invalid ${label.toLowerCase()}`);
  }
  return value;
}

function requireStoredTimestamp(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid ${label.toLowerCase()}`);
  }
  return value;
}

function normalizeStoredEnabled(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (typeof value !== "boolean") {
    throw new Error("Invalid enabled flag");
  }
  return value;
}

function normalizeEnabledInput(value: unknown, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== "boolean") {
    throw createHttpError(400, "Enabled must be a boolean");
  }
  return value;
}

function normalizeStoredRunLog(value: unknown): CronRunLog {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid cron run log");
  }

  const run = value as Partial<CronRunLog>;
  if (run.status !== "running" && run.status !== "success" && run.status !== "error") {
    throw new Error("Invalid cron run log status");
  }
  const normalized: CronRunLog = {
    runId: requireStoredString(run.runId, "Run id"),
    jobId: requireStoredString(run.jobId, "Job id"),
    workspaceId: requireStoredString(run.workspaceId, "Workspace"),
    prompt: requireStoredString(run.prompt, "Prompt"),
    model: requireStoredString(run.model, "Model"),
    thinkingLevel: normalizeStoredThinkingLevel(run.thinkingLevel),
    session: normalizeStoredSession(run.session),
    scheduleLabel: requireStoredString(run.scheduleLabel, "Schedule label"),
    startedAtMs: requireStoredTimestamp(run.startedAtMs, "Started timestamp"),
    status: run.status,
  };
  for (const [key, field] of [
    ["completedAtMs", run.completedAtMs],
    ["durationMs", run.durationMs],
  ] as const) {
    if (field !== undefined) {
      normalized[key] = requireStoredTimestamp(field, key);
    }
  }
  for (const [key, field] of [
    ["sessionId", run.sessionId],
    ["sessionPath", run.sessionPath],
    ["error", run.error],
  ] as const) {
    if (field !== undefined) {
      normalized[key] = requireStoredString(field, key);
    }
  }
  return normalized;
}

function compareRunLogs(left: CronRunLog, right: CronRunLog): number {
  if (left.status === "running" && right.status !== "running") {
    return -1;
  }
  if (left.status !== "running" && right.status === "running") {
    return 1;
  }
  return right.startedAtMs - left.startedAtMs;
}

function boundRunLogs(runs: CronRunLog[]): CronRunLog[] {
  return runs.sort(compareRunLogs).slice(0, RECENT_CRON_RUN_LOG_LIMIT);
}

function normalizeStoredJob(value: unknown): StoredCronJob {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid cron job");
  }

  const job = value as Partial<StoredCronJob>;
  return {
    id: requireStoredString(job.id, "Job id"),
    workspaceId: requireStoredString(job.workspaceId, "Workspace"),
    enabled: normalizeStoredEnabled(job.enabled),
    prompt: requireStoredString(job.prompt, "Prompt"),
    model: requireStoredString(job.model, "Model"),
    thinkingLevel: normalizeStoredThinkingLevel(job.thinkingLevel),
    session: normalizeStoredSession(job.session),
    createdAt: requireStoredTimestamp(job.createdAt, "Created timestamp"),
    updatedAt: requireStoredTimestamp(job.updatedAt, "Updated timestamp"),
    schedule: normalizeStoredSchedule(job.schedule),
    state: normalizeState(job.state),
  };
}

export function toCronJob(job: StoredCronJob): CronJob {
  return {
    id: job.id,
    workspaceId: job.workspaceId,
    enabled: job.enabled,
    prompt: job.prompt,
    model: job.model,
    thinkingLevel: job.thinkingLevel,
    session: toPublicSession(job.session),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    schedule: toPublicSchedule(job.schedule),
    scheduleLabel: formatScheduleLabel(job.schedule),
    state: {
      ...job.state,
      nextRunAtMs: job.enabled ? nextRunAtMs(job.schedule) : undefined,
    },
  };
}

export function compareCronJobsByNextRun(left: CronJob, right: CronJob): number {
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
    return this.withStoreLock(async () => (await this.loadStoreUnlocked()).jobs);
  }

  async readStoredRunLogs(): Promise<CronRunLog[]> {
    return this.withStoreLock(async () => (await this.loadStoreUnlocked()).runs);
  }

  async startRun(run: CronRunLog): Promise<CronRunLog> {
    return this.withStoreLock(async () => {
      const store = await this.loadStoreUnlocked();
      store.runs = boundRunLogs([
        run,
        ...store.runs.filter((candidate) => candidate.runId !== run.runId),
      ]);
      await this.writeStoreUnlocked(store.jobs, store.runs);
      return run;
    });
  }

  async updateRun(runId: string, patch: Partial<CronRunLog>): Promise<CronRunLog | undefined> {
    return this.withStoreLock(async () => {
      const store = await this.loadStoreUnlocked();
      const index = store.runs.findIndex((run) => run.runId === runId);
      if (index < 0) {
        return undefined;
      }
      const next = normalizeStoredRunLog({ ...store.runs[index], ...patch });
      store.runs[index] = next;
      store.runs = boundRunLogs(store.runs);
      await this.writeStoreUnlocked(store.jobs, store.runs);
      return next;
    });
  }

  async createJob(input: CreateCronJobInput): Promise<CronJob> {
    const workspaceId = normalizeNonEmptyString(input.workspaceId, "Workspace");
    await this.requireWorkspace(workspaceId);

    const now = Date.now();
    const job: StoredCronJob = {
      id: randomUUID(),
      workspaceId,
      enabled: normalizeEnabledInput(input.enabled, true),
      prompt: normalizeNonEmptyString(input.prompt, "Prompt"),
      model: normalizeNonEmptyString(input.model, "Model"),
      thinkingLevel: normalizeThinkingLevel(input.thinkingLevel),
      session: normalizeSession(input.session),
      createdAt: now,
      updatedAt: now,
      schedule: normalizeSchedule(input.schedule, now),
      state: {},
    };

    return this.withStoreLock(async () => {
      const store = await this.loadStoreUnlocked();
      store.jobs.push(job);
      await this.writeStoreUnlocked(store.jobs, store.runs);
      return toCronJob(job);
    });
  }

  async updateJob(jobId: string, patch: UpdateCronJobInput): Promise<CronJob> {
    return this.withStoreLock(async () => {
      const store = await this.loadStoreUnlocked();
      const jobs = store.jobs;
      const index = jobs.findIndex((job) => job.id === jobId);
      if (index < 0) {
        throw createHttpError(404, `Unknown cron job: ${jobId}`);
      }

      const current = jobs[index]!;
      const workspaceId =
        typeof patch.workspaceId === "string"
          ? normalizeNonEmptyString(patch.workspaceId, "Workspace")
          : current.workspaceId;
      await this.requireWorkspace(workspaceId);

      const updatedAt = Date.now();
      const next: StoredCronJob = {
        ...current,
        workspaceId,
        enabled: normalizeEnabledInput(patch.enabled, current.enabled),
        prompt:
          patch.prompt == null ? current.prompt : normalizeNonEmptyString(patch.prompt, "Prompt"),
        model: patch.model == null ? current.model : normalizeNonEmptyString(patch.model, "Model"),
        thinkingLevel:
          patch.thinkingLevel == null
            ? current.thinkingLevel
            : normalizeThinkingLevel(patch.thinkingLevel),
        session: patch.session == null ? current.session : normalizeSession(patch.session),
        updatedAt,
        schedule: patch.schedule ? normalizeSchedule(patch.schedule, updatedAt) : current.schedule,
      };

      jobs[index] = next;
      await this.writeStoreUnlocked(jobs, store.runs);
      return toCronJob(next);
    });
  }

  async deleteJob(jobId: string): Promise<CronJob> {
    return this.withStoreLock(async () => {
      const store = await this.loadStoreUnlocked();
      const jobs = store.jobs;
      const job = jobs.find((candidate) => candidate.id === jobId);
      if (!job) {
        throw createHttpError(404, `Unknown cron job: ${jobId}`);
      }

      await this.writeStoreUnlocked(
        jobs.filter((candidate) => candidate.id !== jobId),
        store.runs,
      );
      return toCronJob(job);
    });
  }

  async setJobState(jobId: string, state: Partial<CronJobState>): Promise<CronJob | undefined> {
    return this.withStoreLock(async () => {
      const store = await this.loadStoreUnlocked();
      const jobs = store.jobs;
      const index = jobs.findIndex((job) => job.id === jobId);
      if (index < 0) {
        return undefined;
      }

      const current = jobs[index]!;
      const next: StoredCronJob = {
        ...current,
        updatedAt: Date.now(),
        state: {
          ...current.state,
          ...state,
        },
      };

      jobs[index] = next;
      await this.writeStoreUnlocked(jobs, store.runs);
      return toCronJob(next);
    });
  }

  private async requireWorkspace(workspaceId: string): Promise<void> {
    const workspaces = await listWorkspaces(this.config);
    if (!workspaces.some((workspace) => workspace.id === workspaceId)) {
      throw createHttpError(404, `Unknown workspace: ${workspaceId}`);
    }
  }

  private async loadStoreUnlocked(): Promise<PersistedCronStore> {
    const persisted = await this.readStoreFile();
    if (persisted.version !== CRON_STORE_VERSION) {
      throw new Error(`Unsupported cron store version: ${persisted.version}`);
    }
    const runs = Array.isArray(persisted.runs) ? persisted.runs.map(normalizeStoredRunLog) : [];
    return {
      version: CRON_STORE_VERSION,
      jobs: persisted.jobs.map(normalizeStoredJob),
      runs: boundRunLogs(runs),
    };
  }

  private async readStoreFile(): Promise<RawPersistedCronStore> {
    try {
      const content = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content) as {
        version?: unknown;
        jobs?: unknown;
        runs?: unknown;
      };
      if (!Array.isArray(parsed.jobs)) {
        throw new Error("Invalid cron jobs");
      }
      if (parsed.runs !== undefined && !Array.isArray(parsed.runs)) {
        throw new Error("Invalid cron run logs");
      }
      if (typeof parsed.version !== "number" || !Number.isInteger(parsed.version)) {
        throw new Error(`Invalid cron store version: ${String(parsed.version)}`);
      }
      return { version: parsed.version, jobs: parsed.jobs, runs: parsed.runs ?? [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: CRON_STORE_VERSION, jobs: [], runs: [] };
      }
      throw error;
    }
  }

  private async withStoreLock<T>(operation: () => Promise<T>): Promise<T> {
    const cronDir = path.dirname(this.filePath);
    await fs.mkdir(cronDir, { recursive: true });
    const release = await lockfile.lock(cronDir, {
      realpath: false,
      retries: { retries: 20, factor: 1.2, minTimeout: 10, maxTimeout: 100 },
    });
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  private async writeStoreUnlocked(jobs: StoredCronJob[], runs: CronRunLog[]): Promise<void> {
    const payload: PersistedCronStore = {
      version: CRON_STORE_VERSION,
      jobs,
      runs: boundRunLogs(runs),
    };
    const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await fs.rename(tempPath, this.filePath);
  }
}
