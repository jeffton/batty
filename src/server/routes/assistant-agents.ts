import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config";
import { listWorkspaces } from "../workspaces";

export function registerAssistantAgentsRoutes(app: FastifyInstance, config: AppConfig): void {
  async function fileFor(workspaceId: string): Promise<string> {
    const workspace = (await listWorkspaces(config)).find(
      (candidate) => candidate.id === workspaceId && candidate.isAssistant,
    );
    if (!workspace)
      throw Object.assign(new Error("Assistant workspace not found"), { statusCode: 404 });
    return path.join(workspace.path, "AGENTS.md");
  }

  app.get<{ Params: { workspaceId: string } }>(
    "/api/settings/assistant-agents/:workspaceId",
    async (request) => {
      const file = await fileFor(request.params.workspaceId);
      try {
        return { content: await fs.readFile(file, "utf8") };
      } catch (error) {
        // A workspace without instructions can create its AGENTS.md through the editor.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { content: "" };
        throw error;
      }
    },
  );
  app.post<{ Params: { workspaceId: string }; Body: { content: string } }>(
    "/api/settings/assistant-agents/:workspaceId",
    async (request) => {
      await fs.writeFile(await fileFor(request.params.workspaceId), request.body.content);
      return { content: request.body.content };
    },
  );
}
