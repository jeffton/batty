import type { FastifyInstance } from "fastify";
import type { Runtime } from "../runtime";
import { cronCommand, type CronRequest } from "../cron-command";

type CronRouteRequest = CronRequest & { eventId?: string; text?: string };

export function registerCronRoutes(
  app: FastifyInstance,
  orchestration: Runtime["orchestration"],
  notify?: (id: string, text: string) => Promise<{ published: boolean }>,
) {
  app.post<{ Body: CronRouteRequest }>("/api/cron", (request, reply) => {
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
