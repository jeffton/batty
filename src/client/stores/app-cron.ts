import {
  deleteCronJob as deleteCronJobRequest,
  stopCronRun as stopCronRunRequest,
  updateCronJob as updateCronJobRequest,
} from "@/client/lib/api";
import type { CronJob, RunningCronJob, UpdateCronJobInput } from "@/shared/types";
import type { AppActionContext } from "./app-state";

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

export const cronActions = {
  async updateCronJob(
    this: AppActionContext,
    jobId: string,
    patch: UpdateCronJobInput,
  ): Promise<CronJob> {
    const job = await updateCronJobRequest(jobId, patch);
    const workspaceJobs = this.cronJobsByWorkspace[job.workspaceId] ?? [];
    this.cronJobsByWorkspace = {
      ...this.cronJobsByWorkspace,
      [job.workspaceId]: [
        job,
        ...workspaceJobs.filter((candidate) => candidate.id !== job.id),
      ].sort(compareCronJobsByNextRun),
    };
    return job;
  },

  async deleteCronJob(this: AppActionContext, jobId: string): Promise<CronJob> {
    const job = await deleteCronJobRequest(jobId);
    const workspaceJobs = this.cronJobsByWorkspace[job.workspaceId] ?? [];
    this.cronJobsByWorkspace = {
      ...this.cronJobsByWorkspace,
      [job.workspaceId]: workspaceJobs.filter((candidate) => candidate.id !== job.id),
    };
    return job;
  },

  async stopCronRun(this: AppActionContext, runId: string): Promise<RunningCronJob> {
    const run = await stopCronRunRequest(runId);
    const workspaceRuns = this.runningCronJobsByWorkspace[run.workspaceId] ?? [];
    this.runningCronJobsByWorkspace = {
      ...this.runningCronJobsByWorkspace,
      [run.workspaceId]: workspaceRuns.filter((candidate) => candidate.runId !== run.runId),
    };
    return run;
  },
};
