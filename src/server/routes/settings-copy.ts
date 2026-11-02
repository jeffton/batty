import type { FastifyInstance } from "fastify";

export function registerSettingsCopyRoute(
  app: FastifyInstance,
  readValue: (kind: string, name: string) => Promise<string | undefined>,
): void {
  app.post<{ Body: { kind: string; name: string } }>(
    "/api/settings/copy-value",
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!request.auth) return reply.code(401).send({ error: "Authentication required" });
      const { kind, name } = request.body;
      if (!["provider", "environment", "brave-search"].includes(kind) || typeof name !== "string") {
        return reply.code(400).send({ error: "Invalid setting" });
      }
      const value = await readValue(kind, name);
      if (value === undefined) return reply.code(404).send({ error: "Saved value not found" });
      return { value };
    },
  );
}
