import type { CronJob } from "@/shared/types";
import { formatSessionLabel } from "./cron-state";

export { cronJobsFilePath, CronStore } from "./cron-persistence";
export type { StoredCronJob } from "./cron-persistence";
export { CronService } from "./cron-runtime";
export type { CronJobRunner } from "./cron-runtime";

export function buildCronJobSummary(job: CronJob): string {
  const lines = [
    `Job: ${job.id}`,
    `Workspace: ${job.workspaceId}`,
    `Status: ${job.enabled ? "Enabled" : "Disabled"}`,
    `Schedule: ${job.scheduleLabel}`,
    `Session: ${formatSessionLabel(job.session)}`,
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
