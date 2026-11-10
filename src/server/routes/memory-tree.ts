import type { FastifyInstance } from "fastify";
import type { createMemory } from "../memory";
import { repairMemory } from "../memory-api";

export function registerMemoryTreeRoutes(
  app: FastifyInstance,
  memory: Pick<ReturnType<typeof createMemory>, "browserOverview" | "browserNode" | "repair">,
) {
  // These routes also sit behind the application's API authentication hook.
  app.addHook("onRequest", async (request, reply) => {
    if (request.url.split("?", 1)[0]?.startsWith("/api/memory/tree")) {
      reply.header("Cache-Control", "no-store");
      if (!request.auth) return reply.code(401).send({ error: "Authentication required" });
    }
  });
  app.post<{
    Body: { generation: number; roots: { start: number; count: number }[]; dryRun: boolean };
  }>(
    "/api/memory/tree/repair",
    {
      schema: {
        body: {
          type: "object",
          required: ["generation", "roots", "dryRun"],
          additionalProperties: false,
          properties: {
            generation: { type: "integer", minimum: 0 },
            dryRun: { type: "boolean" },
            roots: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                required: ["start", "count"],
                additionalProperties: false,
                properties: {
                  start: { type: "integer", minimum: 0 },
                  count: { type: "integer", minimum: 1 },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        return await repairMemory(memory, request.body);
      } catch (error) {
        if (error instanceof RangeError) return reply.code(400).send({ error: error.message });
        throw error;
      }
    },
  );
  app.get("/api/memory/tree", async () => memory.browserOverview());
  app.get<{ Params: { id: string; count: string } }>(
    "/api/memory/tree/:id/:count",
    async (request, reply) => {
      const { id, count } = request.params;
      if (!/^\d+$/.test(id) || !/^\d+$/.test(count))
        return reply.code(400).send({ error: "Invalid memory range" });
      try {
        return await memory.browserNode(Number(id), Number(count));
      } catch (error) {
        if (error instanceof RangeError) return reply.code(400).send({ error: error.message });
        throw error;
      }
    },
  );
}
