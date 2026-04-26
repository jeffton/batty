import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { CreateCronJobInput, CronJob, CronJobState, UpdateCronJobInput } from "@/shared/types";
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
  normalizeThinkingLevel,
  migrateStoredSession,
  toPublicSession,
  type StoredCronJobSession,
} from "./cron-state";
import { listWorkspaces } from "./workspaces";

const CRON_STORE_VERSION = 2;

export interface StoredCronJob {
  id: string;
  workspaceId: string;
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
}

interface RawPersistedCronStore {
  version: number;
  jobs: unknown[];
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
    session: normalizeStoredSession(job.session),
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

function migrateStoredJob(value: unknown): StoredCronJob {
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
    session: migrateStoredSession(job.session),
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

export function toCronJob(job: StoredCronJob): CronJob {
  return {
    id: job.id,
    workspaceId: job.workspaceId,
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
      nextRunAtMs: nextRunAtMs(job.schedule),
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
    const persisted = await this.loadStore();
    return persisted.jobs;
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
      session: normalizeSession(input.session),
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
    await this.writeStore(jobs);
    return toCronJob(next);
  }

  private async requireWorkspace(workspaceId: string): Promise<void> {
    const workspaces = await listWorkspaces(this.config);
    if (!workspaces.some((workspace) => workspace.id === workspaceId)) {
      throw createHttpError(404, `Unknown workspace: ${workspaceId}`);
    }
  }

  private async loadStore(): Promise<PersistedCronStore> {
    const persisted = await this.readStoreFile();
    switch (persisted.version) {
      case CRON_STORE_VERSION:
        return {
          version: CRON_STORE_VERSION,
          jobs: persisted.jobs.map(normalizeStoredJob),
        };
      case 1: {
        const jobs = persisted.jobs.map(migrateStoredJob);
        await this.writeStore(jobs);
        return {
          version: CRON_STORE_VERSION,
          jobs,
        };
      }
      default:
        throw new Error(`Unsupported cron store version: ${persisted.version}`);
    }
  }

  private async readStoreFile(): Promise<RawPersistedCronStore> {
    try {
      const content = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content) as { version?: unknown; jobs?: unknown };
      const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
      const version =
        typeof parsed.version === "number" && Number.isInteger(parsed.version) ? parsed.version : 1;
      return { version, jobs };
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
