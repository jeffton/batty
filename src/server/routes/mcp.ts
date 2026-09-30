import type { McpServerConfig } from "@/shared/types";
import { listWorkspaces, resolveWorkspace } from "../workspaces";
import type { RouteContext } from "./context";

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

export function registerMcpRoutes(context: RouteContext): void {
  const { app, config, service, routePath } = context;
  const mcp = service.mcp;

  async function workspaceFor(workspaceId?: string) {
    if (!workspaceId) return undefined;
    const workspaces = await listWorkspaces(config);
    try {
      return resolveWorkspace(workspaces, workspaceId);
    } catch {
      return undefined;
    }
  }

  app.get<{ Querystring: { workspaceId?: string } }>(
    routePath("/api/settings/mcp"),
    async (request, reply) => {
      const workspace = await workspaceFor(request.query.workspaceId);
      if (request.query.workspaceId && !workspace) {
        return reply.code(404).send({ error: `Unknown workspace: ${request.query.workspaceId}` });
      }
      return mcp.readSettings(workspace);
    },
  );

  app.put<{
    Params: { name: string };
    Body: { workspaceId?: string; config?: unknown };
  }>(routePath("/api/settings/mcp/:name"), async (request, reply) => {
    const { name } = request.params;
    if (!SERVER_NAME.test(name)) return reply.code(400).send({ error: "Invalid MCP server name" });
    const { workspaceId, config: serverConfig } = request.body ?? {};
    if (!serverConfig || typeof serverConfig !== "object" || Array.isArray(serverConfig)) {
      return reply.code(400).send({ error: "MCP server config must be an object" });
    }
    const workspace = await workspaceFor(workspaceId);
    if (workspaceId && !workspace) {
      return reply.code(404).send({ error: `Unknown workspace: ${workspaceId}` });
    }
    return mcp.setServer(workspace, name, serverConfig as McpServerConfig);
  });

  app.delete<{ Params: { name: string }; Querystring: { workspaceId?: string } }>(
    routePath("/api/settings/mcp/:name"),
    async (request, reply) => {
      const { name } = request.params;
      if (!SERVER_NAME.test(name))
        return reply.code(400).send({ error: "Invalid MCP server name" });
      const workspace = await workspaceFor(request.query.workspaceId);
      if (request.query.workspaceId && !workspace) {
        return reply.code(404).send({ error: `Unknown workspace: ${request.query.workspaceId}` });
      }
      return mcp.removeServer(workspace, name);
    },
  );

  app.get<{ Params: { workspaceId: string } }>(
    routePath("/api/workspaces/:workspaceId/mcp"),
    async (request, reply) => {
      const workspace = await workspaceFor(request.params.workspaceId);
      if (!workspace) return reply.code(404).send({ error: "Unknown workspace" });
      return mcp.getStatus(workspace);
    },
  );

  app.post<{ Params: { workspaceId: string; name: string } }>(
    routePath("/api/workspaces/:workspaceId/mcp/:name/reconnect"),
    async (request, reply) => {
      const { workspaceId, name } = request.params;
      if (!SERVER_NAME.test(name))
        return reply.code(400).send({ error: "Invalid MCP server name" });
      const workspace = await workspaceFor(workspaceId);
      if (!workspace) return reply.code(404).send({ error: "Unknown workspace" });
      return mcp.reconnect(workspace, name);
    },
  );

  app.post<{ Params: { workspaceId: string; name: string } }>(
    routePath("/api/workspaces/:workspaceId/mcp/:name/logout"),
    async (request, reply) => {
      const { workspaceId, name } = request.params;
      if (!SERVER_NAME.test(name))
        return reply.code(400).send({ error: "Invalid MCP server name" });
      const workspace = await workspaceFor(workspaceId);
      if (!workspace) return reply.code(404).send({ error: "Unknown workspace" });
      return mcp.logout(workspace, name);
    },
  );

  app.post<{ Params: { workspaceId: string; name: string } }>(
    routePath("/api/workspaces/:workspaceId/mcp/:name/login"),
    async (request, reply) => {
      const { workspaceId, name } = request.params;
      if (!SERVER_NAME.test(name))
        return reply.code(400).send({ error: "Invalid MCP server name" });
      const workspace = await workspaceFor(workspaceId);
      if (!workspace) return reply.code(404).send({ error: "Unknown workspace" });
      return mcp.startAuth(workspace, name);
    },
  );

  app.get<{ Params: { attemptId: string } }>(routePath("/api/mcp/auth/:attemptId"), (request) =>
    mcp.getAuthAttempt(request.params.attemptId),
  );

  app.post<{ Params: { attemptId: string }; Body: { callbackUrl?: unknown } }>(
    routePath("/api/mcp/auth/:attemptId"),
    async (request, reply) => {
      if (typeof request.body?.callbackUrl !== "string" || !request.body.callbackUrl) {
        return reply.code(400).send({ error: "callbackUrl must be a non-empty string" });
      }
      return mcp.completeAuth(request.params.attemptId, request.body.callbackUrl);
    },
  );

  app.delete<{ Params: { attemptId: string } }>(routePath("/api/mcp/auth/:attemptId"), (request) =>
    mcp.cancelAuth(request.params.attemptId),
  );
}
