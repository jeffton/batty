import fs from "node:fs";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { RemoteAccess } from "../remote-access";
import type { Runtime } from "../runtime";
import { context } from "../runtime";
import { listWorkspaces } from "../workspaces";
import { nodeRequest, type RemoteWorkerSummary } from "../remote-workers";
import { normalizeRemoteUrl } from "../remote-access";
import type { RemoteDiscovery, RemoteGrant } from "../../shared/remotes";
import type { WorkerCommand } from "../orchestration-workers";
import { streamSession, writeStreamEvent } from "../session-sse";
import { resolveSentFile } from "../send-files";
import type { TranscriptImages } from "../transcript-images";
import type { TaskId } from "@earendil-works/pi-durable";
import { DeliveryRecord } from "../orchestration-history";

declare module "fastify" {
  interface FastifyRequest {
    nodeGrant?: RemoteGrant;
  }
}

/** Owner routes provision links. Node routes have an independent bearer boundary, never owner access. */
export function authenticateNode(
  request: FastifyRequest,
  reply: FastifyReply,
  access: RemoteAccess,
) {
  const bearer = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  request.nodeGrant = bearer ? access.authenticate(bearer) : undefined;
  if (!request.nodeGrant) return reply.code(401).send({ error: "Node authentication required" });
}

export function registerRemoteRoutes(app: FastifyInstance, runtime: Runtime) {
  const remotes = runtime.remotes;
  const access = remotes.access;
  const streams = new Set<import("node:http").ServerResponse>();
  let closing = false;
  app.addHook("onRequest", async (request, reply) => {
    if (closing && request.url.startsWith("/api/node/"))
      return reply.code(503).send({ error: "Instance is shutting down" });
  });
  app.get("/api/remotes", async () => ({
    ...access.identity(),
    grants: access.listGrants(),
    connections: access.listConnections(),
  }));
  app.post<{ Body: { action: string; id?: string; label?: string; url?: string; token?: string } }>(
    "/api/remotes",
    async (request) => {
      const input = request.body;
      switch (input.action) {
        case "grant-add":
          return access.issue(input.label!);
        case "grant-list":
          return access.listGrants();
        case "grant-revoke": {
          await access.revoke(input.id!);
          // Valid peers reconnect; a revoked grant cannot open another stream.
          for (const stream of streams) stream.end();
          return { ok: true };
        }
        case "connection-list":
          return access.listConnections();
        case "connection-add": {
          const connection = {
            id: input.id!,
            label: input.label!,
            token: input.token!,
            url: normalizeRemoteUrl(input.url!),
          };
          const identity = await nodeRequest<{ instanceId: string; grantId: string }>(
            connection,
            "identity",
          );
          if (identity.instanceId === access.identity().instanceId)
            throw new Error("Cannot connect a Batty instance to itself");
          if (access.listConnections().some((item) => item.instanceId === identity.instanceId))
            throw new Error("This remote instance is already connected");
          await remotes.bindOrigin(connection.id, identity.instanceId);
          await access.addConnection({
            ...connection,
            instanceId: identity.instanceId,
            grantId: identity.grantId,
          });
          remotes.connect(connection.id);
          return { ok: true };
        }
        case "connection-remove": {
          remotes.disconnect(input.id!);
          await access.removeConnection(input.id!);
          return { ok: true };
        }
        default:
          throw new Error("Unknown remote provisioning action");
      }
    },
  );
  app.get("/api/node/identity", async (request) => ({
    ...access.identity(),
    grantId: request.nodeGrant!.id,
  }));
  app.get("/api/node/workspaces", async (): Promise<RemoteDiscovery> => {
    const main = await runtime.main.agent(context);
    return {
      workspaces: await listWorkspaces(runtime.config),
      models: await runtime.listModels(),
      defaultModel: main.model && `${main.model.provider}/${main.model.modelId}`,
    };
  });
  app.post<{ Body: { requestId: string; command: WorkerCommand } }>(
    "/api/node/commands",
    async (request) => {
      const command = request.body.command;
      if (
        !["run", "resume", "queue", "steer", "stop", "list", "inspect", "await"].includes(
          command.action,
        ) ||
        command.nodeId ||
        command.sessionId?.startsWith("remote:")
      )
        throw new Error("Invalid node worker action");
      return runtime.orchestration.nodeCommand(
        request.nodeGrant!.id,
        request.body.requestId,
        command,
      );
    },
  );
  app.get<{ Params: { id: string } }>("/api/node/assignments/:id", async (request, reply) => {
    const task = await runtime.harness.getTask(
      Number(request.params.id) as TaskId<string>,
      context,
    );
    if (!task || task.kind !== "batty.delivery")
      return reply.code(404).send({ error: "Unknown worker assignment" });
    return {
      status: task.state.status === "terminal" ? task.state.outcome.status : "running",
      ...(task.state.status === "terminal" && task.state.outcome.status === "completed"
        ? { text: task.state.outcome.result }
        : {}),
      artifacts: (await runtime.harness.snapshot(DeliveryRecord, request.params.id, context))
        ?.artifacts,
    };
  });
  async function catalog() {
    const workers: RemoteWorkerSummary[] = [];
    let cursor: string | undefined;
    do {
      const result = await runtime.orchestration.queryWorkers({
        action: "list",
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      const output = result.output as Array<{ text: string }>;
      const page = JSON.parse(output[0]!.text) as {
        workers: RemoteWorkerSummary[];
        nextCursor?: string;
      };
      workers.push(...page.workers);
      cursor = page.nextCursor;
    } while (cursor);
    return workers;
  }
  app.get("/api/node/catalog/events", async (request, reply) => {
    reply.hijack();
    streams.add(reply.raw);
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    });
    let dirty = true;
    let flushing = false;
    let closed = false;
    const flush = async () => {
      if (flushing || closed) return;
      flushing = true;
      try {
        while (dirty && !closed) {
          dirty = false;
          await writeStreamEvent(
            reply.raw,
            `data: ${JSON.stringify({ workers: await catalog() })}\n\n`,
          );
        }
      } catch (error) {
        app.log.error(error);
        reply.raw.end();
      } finally {
        flushing = false;
      }
    };
    const stop = runtime.harness.subscribeCommits((publication) => {
      if (
        publication.changes.some(
          (change) =>
            change.type === "document" &&
            ["batty.worker", "batty.orchestration"].includes(change.record.kind),
        )
      ) {
        dirty = true;
        queueMicrotask(() => void flush());
      }
    });
    const heartbeat = setInterval(() => {
      if (!reply.raw.writableNeedDrain) reply.raw.write("event: heartbeat\ndata: {}\n\n");
    }, 5000);
    reply.raw.once("close", () => {
      closed = true;
      clearInterval(heartbeat);
      stop();
      streams.delete(reply.raw);
    });
    void flush();
  });
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    "/api/node/sessions/:id/events",
    async (request, reply) => {
      const conversation = await runtime.conversation(request.params.id);
      const metadata = await runtime.orchestration.metadata(conversation.id);
      if (!metadata?.isSubagent && !metadata?.isCron)
        return reply.code(404).send({ error: "Unknown worker" });
      reply.hijack();
      streams.add(reply.raw);
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      });
      // Preserve image bytes; owner-facing image URLs belong to the producing installation.
      streamSession(
        reply.raw,
        runtime,
        conversation.id,
        { state: async (state) => state } as TranscriptImages,
        request.query.after ?? "0",
        (error) => app.log.error(error),
      );
      reply.raw.once("close", () => streams.delete(reply.raw));
    },
  );
  app.get<{ Params: { workspace: string; session: string; tool: string; id: string } }>(
    "/api/node/files/:workspace/:session/:tool/:id",
    async (request, reply) => {
      const file = await resolveSentFile({
        rootDir: runtime.config.sentFilesDir,
        workspaceId: request.params.workspace,
        sessionId: request.params.session,
        toolCallId: request.params.tool,
        fileId: request.params.id,
      });
      reply.type(file.descriptor.mimeType);
      return reply.send(fs.createReadStream(file.storedPath));
    },
  );
  return () => {
    closing = true;
    for (const stream of streams) stream.destroy();
  };
}
