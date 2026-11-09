import fs from "node:fs";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { RemoteAccess, PairingClaim } from "../remote-access";
import type { Runtime } from "../runtime";
import { context } from "../runtime";
import { listWorkspaces } from "../workspaces";
import { nodeRequest, type RemoteWorkerSummary } from "../remote-workers";
import { normalizeRemoteUrl } from "../remote-access";
import type { RemoteDiscovery, RemoteGrant } from "../../shared/remotes";
import type { WorkerCommand } from "../orchestration-workers";
import { streamSession, writeStreamEvent } from "../session-sse";
import {
  receiveWorkerFiles,
  MAX_WORKER_FILE_BYTES,
  type WorkerFileMetadata,
  type WorkerInputFile,
} from "../worker-files";
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
  if (request.method === "POST" && request.url === "/api/node/pair") {
    if (bearer && access.canClaim(bearer)) return;
    return reply.code(401).send({ error: "Pairing token is invalid or has been used" });
  }
  request.nodeGrant = bearer ? access.authenticate(bearer) : undefined;
  if (!request.nodeGrant) return reply.code(401).send({ error: "Node authentication required" });
}

export function registerRemoteRoutes(app: FastifyInstance, runtime: Runtime) {
  const remotes = runtime.remotes;
  const access = remotes.access;
  const streams = new Map<import("node:http").ServerResponse, string | undefined>();
  const closeOfflineStreams = (id: string) => {
    if (remotes.reverse.hasControl(id)) return;
    for (const [stream, peerId] of streams) if (peerId === id) stream.end();
  };
  remotes.changes.on("catalog", closeOfflineStreams);
  const requireLivePeer = (request: FastifyRequest): string => {
    const bearer = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    const grant = bearer && access.authenticate(bearer);
    const connection = grant && access.pairedConnection(grant.id);
    if (!connection) throw Object.assign(new Error("Node access was removed"), { statusCode: 401 });
    if (!remotes.reverse.hasControl(connection.id))
      throw Object.assign(new Error("Paired peer is offline"), { statusCode: 503 });
    return connection.id;
  };
  let closing = false;
  app.addHook("onRequest", async (request, reply) => {
    if (closing && request.url.startsWith("/api/node/"))
      return reply.code(503).send({ error: "Instance is shutting down" });
  });
  app.addHook("onRequest", async (request, reply) => {
    if (
      !request.nodeGrant ||
      request.url.startsWith("/api/node/reverse/") ||
      request.url === "/api/node/unpair"
    )
      return;
    const connection = access.pairedConnection(request.nodeGrant.id);
    if (connection && !remotes.reverse.hasControl(connection.id)) {
      return reply.code(503).send({ error: "Paired peer is offline" });
    }
  });
  app.get("/api/remotes", async () => ({
    ...access.identity(),
    grants: access.listInvitations(),
    connections: access.listConnections().map((connection) => ({
      ...connection,
      status: remotes.reverse.status(connection.id),
    })),
  }));
  app.post<{
    Body: {
      action: string;
      id?: string;
      url?: string;
      token?: string;
    };
  }>("/api/remotes", async (request) => {
    const input = request.body;
    switch (input.action) {
      case "token-list":
        return access.listInvitations();
      case "connection-list":
        return access.listConnections();
      case "token-generate":
        return access.issueInvitation();
      case "token-revoke": {
        await access.revoke(input.id!);
        remotes.reverse.reconfigure();
        // Valid peers reconnect; a revoked grant cannot open another stream.
        for (const stream of streams.keys()) stream.end();
        return { ok: true };
      }

      case "connection-add": {
        const url = normalizeRemoteUrl(input.url!);
        if (!input.token?.trim()) throw new Error("Pairing token is required");
        if (access.completedPairing(url, input.token)) return { ok: true };
        const claim = await access.beginPairing(url, input.token!);
        const response = await fetch(new URL("api/node/pair", url), {
          method: "POST",
          headers: { authorization: `Bearer ${input.token!}`, "content-type": "application/json" },
          body: JSON.stringify(claim),
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) {
          const detail = (await response.json()) as { message?: string; error?: string };
          throw new Error(
            `Pairing failed: ${detail.message ?? detail.error ?? `HTTP ${response.status}`}`,
          );
        }
        const identity = (await response.json()) as {
          instanceId: string;
          name: string;
          grantId: string;
        };
        await remotes.bindOrigin(identity.instanceId, identity.instanceId);
        const id = await access.completePairing(url, input.token!, identity);
        remotes.connect(id);
        remotes.reverse.reconfigure();
        return { ok: true };
      }
      case "connection-remove": {
        const connection = access.getConnection(input.id!);
        const notification =
          connection?.localGrantId && remotes.reverse.hasControl(connection.id)
            ? remotes.reverse.notifyRemoval(connection).catch((error: unknown) => {
                app.log.warn(
                  { err: error },
                  "Peer removal notification interrupted; local access revoked",
                );
              })
            : undefined;
        // Revocation and stream cleanup never wait for a sleeping or unreachable peer.
        await access.removeConnection(input.id!);
        remotes.disconnect(input.id!);
        remotes.reverse.reconfigure();
        for (const stream of streams.keys()) stream.end();
        await notification;
        return { ok: true };
      }
      default:
        throw new Error("Unknown remote provisioning action");
    }
  });
  app.post<{ Body: PairingClaim }>("/api/node/pair", async (request) => {
    const invitation = request.headers.authorization!.slice(7);
    const identity = await access.claimInvitation(invitation, request.body);
    await remotes.bindOrigin(request.body.instanceId, request.body.instanceId);
    remotes.reverse.reconfigure();
    return identity;
  });
  app.post("/api/node/unpair", async (request) => {
    const connection = access.pairedConnection(request.nodeGrant!.id);
    if (!connection) throw new Error("Unknown paired peer");
    await access.removeConnection(connection.id);
    remotes.disconnect(connection.id);
    // Let the response drain before closing its own reverse transfer.
    setImmediate(() => {
      remotes.reverse.reconfigure();
      for (const stream of streams.keys()) stream.end();
    });
    return { ok: true };
  });
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
  app.post<{ Body: { requestId: string; command: WorkerCommand; files?: WorkerFileMetadata[] } }>(
    "/api/node/commands",
    async (request) => {
      let body = request.body;
      let files: WorkerInputFile[] | undefined;
      const parts = request.isMultipart()
        ? request.parts({
            limits: {
              files: 32,
              fields: 1,
              parts: 33,
              fileSize: MAX_WORKER_FILE_BYTES,
              fieldSize: 1024 * 1024,
            },
          })
        : undefined;
      if (parts) {
        const first = await parts.next();
        if (
          first.done ||
          first.value.type !== "field" ||
          first.value.fieldname !== "command" ||
          typeof first.value.value !== "string" ||
          first.value.valueTruncated
        )
          throw new Error("Worker command metadata must be the first multipart field");
        body = JSON.parse(first.value.value);
      }
      const command = body.command;
      if (!command || typeof body.requestId !== "string" || !body.requestId.trim())
        throw new Error("Node command requires a command and requestId");
      if (
        !["run", "resume", "queue", "steer", "stop", "list", "inspect", "await"].includes(
          command.action,
        ) ||
        command.nodeId ||
        command.files !== undefined ||
        command.sessionId?.startsWith("remote:")
      )
        throw new Error("Invalid node worker action");
      if (parts) {
        if (!["run", "queue", "resume", "steer"].includes(command.action))
          throw new Error("Files are supported only on run, queue, resume and steer");
        files = await receiveWorkerFiles(
          { rootDir: runtime.config.sentFilesDir, baseUrl: runtime.config.baseUrl },
          `node:${request.nodeGrant!.id}:${body.requestId}`,
          body.files!,
          parts,
        );
      } else if (body.files !== undefined)
        throw new Error("Worker files require multipart transfer");
      requireLivePeer(request);
      return runtime.orchestration.nodeCommand(
        request.nodeGrant!.id,
        body.requestId,
        command,
        files,
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
    const peerId = requireLivePeer(request);
    reply.hijack();
    streams.set(reply.raw, peerId);
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
    const observation = runtime.harness.observeCommits({
      advance: (publication) => {
        if (
          publication.changes.some(
            (change) =>
              (change.type === "document" &&
                ["batty.worker", "batty.orchestration"].includes(change.record.kind)) ||
              (change.type === "task" &&
                change.value.kind === "batty.delivery" &&
                change.value.state.status === "terminal"),
          )
        ) {
          dirty = true;
          queueMicrotask(() => void flush());
        }
      },
      end: () => {},
    });
    const heartbeat = setInterval(() => {
      if (!reply.raw.writableNeedDrain) reply.raw.write("event: heartbeat\ndata: {}\n\n");
    }, 5000);
    reply.raw.once("close", () => {
      closed = true;
      clearInterval(heartbeat);
      observation.detach();
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
      const peerId = requireLivePeer(request);
      reply.hijack();
      streams.set(reply.raw, peerId);
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
      const peerId = requireLivePeer(request);
      streams.set(reply.raw, peerId);
      reply.raw.once("close", () => streams.delete(reply.raw));
      reply.type(file.descriptor.mimeType);
      return reply.send(fs.createReadStream(file.storedPath));
    },
  );
  return () => {
    closing = true;
    remotes.changes.off("catalog", closeOfflineStreams);
    for (const stream of streams.keys()) stream.destroy();
  };
}
