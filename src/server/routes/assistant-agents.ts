import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config";
import { listWorkspaces } from "../workspaces";

async function fileFor(config: AppConfig, workspaceId: string): Promise<string> {
  const workspace = (await listWorkspaces(config)).find(
    (candidate) => candidate.id === workspaceId && candidate.isAssistant,
  );
  if (!workspace)
    throw Object.assign(new Error("Assistant workspace not found"), { statusCode: 404 });
  return path.join(workspace.path, "AGENTS.md");
}

export async function assistantAgentsRead(
  config: AppConfig,
  workspaceId: string,
): Promise<{ content: string }> {
  try {
    return { content: await fs.readFile(await fileFor(config, workspaceId), "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { content: "" };
    throw error;
  }
}

export async function assistantAgentsWrite(
  config: AppConfig,
  workspaceId: string,
  content: string,
): Promise<{ content: string }> {
  await fs.writeFile(await fileFor(config, workspaceId), content);
  return { content };
}

export function registerAssistantAgentsRoutes(app: FastifyInstance, config: AppConfig): void {
  app.get<{ Params: { workspaceId: string } }>(
    "/api/settings/assistant-agents/:workspaceId",
    async (request) => {
      return assistantAgentsRead(config, request.params.workspaceId);
    },
  );
  app.post<{ Params: { workspaceId: string }; Body: { content: string } }>(
    "/api/settings/assistant-agents/:workspaceId",
    async (request) => {
      return assistantAgentsWrite(config, request.params.workspaceId, request.body.content);
    },
  );
}
