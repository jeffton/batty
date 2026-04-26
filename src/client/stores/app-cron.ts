import {
  deleteCronJob as deleteCronJobRequest,
  updateCronJob as updateCronJobRequest,
} from "@/client/lib/api";
import type { CronJob, UpdateCronJobInput } from "@/shared/types";
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
};
