import type { WorkspaceSnapshot } from "@/shared/types";
import { setAssistantWorkspace, setWorkspacePinned } from "../options";
import { createWorkspace, listWorkspaces, resolveWorkspace } from "../workspaces";
import type { RouteContext } from "./context";

export function registerWorkspaceRoutes(
  context: RouteContext,
  workspaceSubscribers: Map<string, Set<(snapshot: WorkspaceSnapshot) => void>>,
): void {
  const { app, config, service, cronService, routePath, workspaceSnapshot } = context;

  app.get(routePath("/api/workspaces"), async () => {
    return listWorkspaces(config);
  });

  app.post<{ Body: { name?: string; rootPath?: string } }>(
    routePath("/api/workspaces"),
    async (request) => {
      return createWorkspace(config, request.body?.name ?? "", request.body?.rootPath);
    },
  );

  app.post<{ Params: { workspaceId: string }; Body: { pinned?: boolean } }>(
    routePath("/api/workspaces/:workspaceId/pin"),
    async (request) => {
      const pinned = request.body?.pinned;
      if (typeof pinned !== "boolean") {
        throw new Error("Missing pinned state");
      }

      const workspaces = await listWorkspaces(config);
      resolveWorkspace(workspaces, request.params.workspaceId);
      await setWorkspacePinned(config.battyDir, request.params.workspaceId, pinned);
      return listWorkspaces(config);
    },
  );

  app.post<{ Params: { workspaceId: string }; Body: { selected?: boolean } }>(
    routePath("/api/workspaces/:workspaceId/assistant"),
    async (request) => {
      const selected = request.body?.selected;
      if (typeof selected !== "boolean") {
        throw new Error("Missing assistant selection state");
      }

      const workspaces = await listWorkspaces(config);
      resolveWorkspace(workspaces, request.params.workspaceId);
      await setAssistantWorkspace(
        config.battyDir,
        selected ? request.params.workspaceId : undefined,
      );
      return listWorkspaces(config);
    },
  );

  app.get<{ Params: { workspaceId: string } }>(
    routePath("/api/workspaces/:workspaceId/sessions"),
    async (request) => {
      const workspaces = await listWorkspaces(config);
      const workspace = resolveWorkspace(workspaces, request.params.workspaceId);
      return service.listSessionSummaries(workspace);
    },
  );

  app.get<{ Params: { workspaceId: string } }>(
    routePath("/api/workspaces/:workspaceId/events"),
    async (request, reply) => {
      const snapshot = await workspaceSnapshot(request.params.workspaceId);

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });

      const send = (payload: WorkspaceSnapshot) => {
        reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
      };

      const subscribers = workspaceSubscribers.get(request.params.workspaceId) ?? new Set();
      subscribers.add(send);
      workspaceSubscribers.set(request.params.workspaceId, subscribers);
      send(snapshot);

      const heartbeat = setInterval(() => {
        reply.raw.write(": keep-alive\n\n");
      }, 15000);

      request.raw.on("close", () => {
        clearInterval(heartbeat);
        const current = workspaceSubscribers.get(request.params.workspaceId);
        current?.delete(send);
        if (current && current.size === 0) {
          workspaceSubscribers.delete(request.params.workspaceId);
        }
        reply.raw.end();
      });
    },
  );

  app.get<{ Params: { workspaceId: string } }>(
    routePath("/api/workspaces/:workspaceId/cron-jobs"),
    async (request) => {
      const workspaces = await listWorkspaces(config);
      const workspace = resolveWorkspace(workspaces, request.params.workspaceId);
      return cronService.listJobs(workspace.id);
    },
  );

  app.get<{ Params: { workspaceId: string } }>(
    routePath("/api/workspaces/:workspaceId/cron-runs"),
    async (request) => {
      const workspaces = await listWorkspaces(config);
      const workspace = resolveWorkspace(workspaces, request.params.workspaceId);
      return cronService.listRunningJobs(workspace.id);
    },
  );
}
