import type { WorkspaceSnapshot } from "@/shared/types";
import { setAssistantWorkspace, setWorkspacePinned } from "../options";
import { createWorkspace, listWorkspaces, resolveWorkspace } from "../workspaces";
import type { RouteContext } from "./context";
import { startEventStream } from "./event-stream";

export function registerWorkspaceRoutes(
  context: RouteContext,
  workspaceSubscribers: Set<(snapshot: WorkspaceSnapshot) => void>,
): void {
  const { app, config, service, cronService, routePath, workspaceSnapshots } = context;

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

  app.get(routePath("/api/workspaces/events"), async (request, reply) => {
    startEventStream(reply.raw);
    let initializing = true;
    let closed = false;
    const pendingSnapshots = new Map<string, WorkspaceSnapshot>();
    const writeSnapshot = (snapshot: WorkspaceSnapshot) => {
      reply.raw.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    };
    const send = (snapshot: WorkspaceSnapshot) => {
      if (initializing) {
        const pending = pendingSnapshots.get(snapshot.workspaceId);
        if (!pending || (snapshot.revision ?? 0) > (pending.revision ?? 0)) {
          pendingSnapshots.set(snapshot.workspaceId, snapshot);
        }
        return;
      }
      writeSnapshot(snapshot);
    };

    workspaceSubscribers.add(send);
    const heartbeat = setInterval(() => {
      reply.raw.write(": keep-alive\n\n");
    }, 15000);
    const cleanup = () => {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(heartbeat);
      workspaceSubscribers.delete(send);
      reply.raw.end();
    };

    request.raw.on("close", cleanup);

    let initialSnapshots: WorkspaceSnapshot[];
    try {
      initialSnapshots = await workspaceSnapshots();
    } catch (error) {
      cleanup();
      throw error;
    }
    if (closed) {
      return;
    }
    const initialRevisions = new Map<string, number>();
    for (const snapshot of initialSnapshots) {
      initialRevisions.set(snapshot.workspaceId, snapshot.revision ?? 0);
      writeSnapshot(snapshot);
    }
    initializing = false;
    for (const snapshot of pendingSnapshots.values()) {
      if ((snapshot.revision ?? 0) > (initialRevisions.get(snapshot.workspaceId) ?? -1)) {
        writeSnapshot(snapshot);
      }
    }
  });

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

  app.get<{ Params: { workspaceId: string } }>(
    routePath("/api/workspaces/:workspaceId/cron-run-logs"),
    async (request) => {
      const workspaces = await listWorkspaces(config);
      const workspace = resolveWorkspace(workspaces, request.params.workspaceId);
      return cronService.listRecentRunLogs(workspace.id);
    },
  );
}
