import type { FastifyInstance } from "fastify";
import type { Runtime } from "../runtime";
import type { CronJob, CronJobInput } from "../orchestration";

type CronRequest = Partial<CronJobInput> & {
  action: string;
  jobId?: string;
  runId?: string;
  limit?: number;
};

export async function cronCommand(orchestration: Runtime["orchestration"], input: CronRequest) {
  switch (input.action) {
    case "list":
      return orchestration.listJobSummaries(input.workspaceId);
    case "get":
      return orchestration.getJob(input.jobId!);
    case "import":
      return orchestration.importJob(input as unknown as CronJob);
    case "add":
      return orchestration.addJob(input as CronJobInput);
    case "update":
      return orchestration.updateJob(input.jobId!, input);
    case "remove":
      await orchestration.removeJob(input.jobId!);
      return { ok: true };
    case "list-running":
      return orchestration.listRunningCron(input.jobId);
    case "list-run-logs":
      return orchestration.listRunLogs(input.jobId, input.limit, input.workspaceId);
    case "stop-running": {
      if (input.runId) await orchestration.stopRunning(input.runId);
      else {
        for (const run of await orchestration.listRunningCron(input.jobId))
          await orchestration.stopRunning(run.id);
      }
      return { ok: true };
    }
    default:
      throw new Error(`Unknown cron action: ${input.action}`);
  }
}

export function registerCronRoutes(app: FastifyInstance, orchestration: Runtime["orchestration"]) {
  app.post<{ Body: CronRequest }>("/api/cron", (request) =>
    cronCommand(orchestration, request.body),
  );
}
