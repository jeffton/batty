import type { FastifyInstance } from "fastify";
import type { Runtime } from "../runtime";
import type { CronJob, CronJobInput } from "../orchestration";

type CronRequest = Partial<CronJobInput> & {
  action: string;
  jobId?: string;
  runId?: string;
  limit?: number;
  eventId?: string;
  text?: string;
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

export function registerCronRoutes(
  app: FastifyInstance,
  orchestration: Runtime["orchestration"],
  notify?: (id: string, text: string) => Promise<{ published: boolean }>,
) {
  app.post<{ Body: CronRequest }>("/api/cron", (request, reply) => {
    if (request.body.action !== "notify" || !notify)
      return cronCommand(orchestration, request.body);
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.ip))
      return reply.code(403).send({ error: "System notifications require loopback" });
    const { eventId, text } = request.body;
    if (typeof eventId !== "string" || !eventId.trim() || typeof text !== "string" || !text.trim())
      return reply.code(400).send({ error: "System notification requires eventId and text" });
    return notify(eventId, text.trim());
  });
}
