import { mkdir, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import WebSocket from "ws";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { expect, test as serialTest, vi } from "vite-plus/test";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { loadConfig } from "./config";
import { Runtime, context } from "./runtime";
import type { RemoteWorkers } from "./remote-workers";
import type { RemoteConnectionCredentials } from "./remote-access";
import { RpcError } from "../shared/rpc/channel";
import type { NodeInputs, NodeOperation } from "../shared/node-api";
import type { PairingClaim } from "./remote-access";
import { authenticateNode, registerRemoteRoutes } from "./routes/remotes";
import { registerReverseRemoteRoutes, registerRpcSocketTransport } from "./routes/reverse-remotes";
import type { SentFileDescriptor } from "../shared/types";

// Per-test runtimes use separate directories, ports and faux providers. Vitest bounds
// these concurrent cases with maxConcurrency in vite.config.ts.
const test = serialTest.concurrent;
// This suite verifies protocol state and reopen behavior, not power-loss durability.
// Keep real SQLite/WAL/files on Linux tmpfs to avoid thousands of disk fsyncs.
const storageRoot = process.platform === "linux" ? "/dev/shm" : tmpdir();

async function nodeRequest<T>(
  connection: RemoteConnectionCredentials,
  operation: string,
  input: unknown,
  requester: RemoteWorkers["requestNode"],
): Promise<T> {
  // Tests deliberately exercise malformed wire payloads as well as valid calls.
  return (
    await requester(connection, operation as NodeOperation, input as NodeInputs[NodeOperation])
  ).value as T;
}

async function eventually(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function openInstance(directory: string, name: string, fileStatus = 200, baseUrl = "/") {
  const root = join(directory, name);
  const work = join(root, "work");
  await mkdir(join(root, ".batty", "skills"), { recursive: true });
  await mkdir(join(work, ".batty", "skills"), { recursive: true });
  await writeFile(
    join(root, ".batty", "options.json"),
    JSON.stringify({
      workspacesRoots: [root],
      assistantWorkspaceId: "work",
      webPushSubject: "mailto:integration@example.com",
      baseUrl,
    }),
  );
  await writeFile(join(work, "origin.txt"), `tools executed on ${name}`);
  await writeFile(join(work, "AGENTS.md"), `Unique instance ${name} workspace guidance.`);
  const config = {
    ...(await loadConfig(root)),
    selfPath: work,
    workspacesRoots: [root],
    defaultProvider: "faux",
    defaultModel: `model-${name}`,
    defaultThinkingLevel: "off" as const,
  };
  const faux = fauxProvider({ models: [{ id: `model-${name}` }], tokensPerSecond: 10000 });
  const runtime = await Runtime.open(config, {
    resume: false,
    beforeStart: (opened) => {
      opened.models.registerNativeProvider(faux.provider);
    },
  });
  // Match production shutdown, including unused HTTP-pool preconnections.
  const app = Fastify({ forceCloseConnections: true });
  const fileRequests: string[] = [];
  const pairingClaims: PairingClaim[] = [];
  let nodeOnline = true;
  app.addHook("onRequest", async (request, reply) => {
    if (!nodeOnline && request.url.startsWith("/api/node/"))
      return reply.code(503).send({ error: "Simulated sleeping peer" });
  });
  app.addHook("preHandler", async (request) => {
    if (request.url === "/api/node/pair")
      pairingClaims.push(structuredClone(request.body as PairingClaim));
  });
  let assignmentFailures = 0;
  let failedAssignmentRequests = 0;
  const sessionStreams: Array<{ url: string; closed: boolean }> = [];
  const nativeCalls: string[] = [];
  const handleNode = runtime.remotes.handleNode.bind(runtime.remotes);
  vi.spyOn(runtime.remotes, "handleNode").mockImplementation(
    async (connection, operation, input, call) => {
      nativeCalls.push(operation);
      if (!nodeOnline) throw new RpcError("OFFLINE", "Simulated sleeping peer");
      if (operation === "node.assignment" && assignmentFailures > 0) {
        assignmentFailures--;
        failedAssignmentRequests++;
        throw new RpcError("INTERNAL", "Simulated transient assignment-status failure");
      }
      if (operation === "node.file") {
        const file = input as {
          workspaceId: string;
          sessionId: string;
          toolCallId: string;
          fileId: string;
        };
        fileRequests.push(
          [file.workspaceId, file.sessionId, file.toolCallId, file.fileId]
            .map(encodeURIComponent)
            .join("/"),
        );
        if (fileStatus !== 200)
          throw new RpcError(fileStatus === 404 ? "NOT_FOUND" : "INTERNAL", "File unavailable");
      }
      if (operation === "node.session.watch") {
        const stream = {
          url: `node.session.watch:${(input as { sessionId: string }).sessionId}`,
          closed: false,
        };
        sessionStreams.push(stream);
        call.signal.addEventListener(
          "abort",
          () => {
            stream.closed = true;
          },
          { once: true },
        );
      }
      return handleNode(connection, operation, input, call);
    },
  );
  await registerRpcSocketTransport(app);
  // Match main.ts's independent node bearer boundary, using a fixture-only owner header.
  app.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/api/node/")) {
      return authenticateNode(request, reply, runtime.remotes.access);
    }
    if (request.headers["x-test-owner"] !== name)
      return reply.code(401).send({ error: "Owner authentication required" });
  });
  registerRemoteRoutes(app, runtime);
  registerReverseRemoteRoutes(app, runtime);
  const upgradedSockets = new Set<Duplex>();
  app.server.on("upgrade", (_request, socket) => {
    upgradedSockets.add(socket);
    socket.once("close", () => upgradedSockets.delete(socket));
  });
  const upstreamUrl = `${await app.listen({ host: "127.0.0.1", port: 0 })}/`;
  const prefix = config.baseUrl === "/" ? "" : config.baseUrl;
  const proxyRequests: string[] = [];
  // Production routes are unprefixed: a path-mounted reverse proxy strips the
  // configured app prefix before forwarding pairing bodies and socket upgrades.
  const proxy = prefix
    ? createServer((incoming, outgoing) => {
        const path = incoming.url!;
        proxyRequests.push(path);
        if (!path.startsWith(`${prefix}/`)) {
          outgoing.writeHead(404).end();
          return;
        }
        const upstream = httpRequest(
          new URL(path.slice(prefix.length), upstreamUrl),
          { method: incoming.method, headers: incoming.headers },
          (response) => {
            outgoing.writeHead(response.statusCode!, response.headers);
            response.pipe(outgoing);
            outgoing.on("close", () => response.destroy());
          },
        );
        upstream.on("error", () => outgoing.destroy());
        outgoing.on("close", () => upstream.destroy());
        incoming.pipe(upstream);
      })
    : undefined;
  proxy?.on("upgrade", (incoming, downstream, head) => {
    const path = incoming.url!;
    proxyRequests.push(path);
    if (!path.startsWith(`${prefix}/`)) {
      downstream.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstream = httpRequest(new URL(path.slice(prefix.length), upstreamUrl), {
      method: incoming.method,
      headers: incoming.headers,
      // Upgrade attempts must not return rejected-handshake sockets to the HTTP pool.
      agent: false,
    });
    upstream.on("upgrade", (response, socket, upstreamHead) => {
      downstream.write(
        `HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers)
          .map(([name, value]) => `${name}: ${value}`)
          .join("\r\n")}\r\n\r\n`,
      );
      if (head.length) socket.write(head);
      if (upstreamHead.length) downstream.write(upstreamHead);
      socket.pipe(downstream).pipe(socket);
      socket.on("error", () => downstream.destroy());
      downstream.on("error", () => socket.destroy());
      socket.on("close", () => downstream.destroy());
      downstream.on("close", () => socket.destroy());
    });
    upstream.on("response", (response) => {
      downstream.end(`HTTP/1.1 ${response.statusCode} Rejected\r\nConnection: close\r\n\r\n`);
      response.resume();
    });
    upstream.on("error", () => downstream.destroy());
    downstream.on("close", () => upstream.destroy());
    upstream.end();
  });
  if (proxy) await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const url = proxy
    ? `http://127.0.0.1:${(proxy.address() as AddressInfo).port}${prefix}/`
    : upstreamUrl;
  let closed = false;
  return {
    app,
    runtime,
    faux,
    config,
    work,
    url,
    id: runtime.remotes.access.identity().instanceId,
    sessionStreams,
    nativeCalls,
    fileRequests,
    pairingClaims,
    proxyRequests,
    setNodeOnline(online: boolean) {
      nodeOnline = online;
      if (!online) {
        app.server.closeAllConnections();
        for (const socket of upgradedSockets) socket.destroy();
      }
    },
    setFileStatus(status: number) {
      fileStatus = status;
    },
    failNextAssignmentRequest() {
      assignmentFailures++;
    },
    failedAssignmentRequests: () => failedAssignmentRequests,
    owner: { "x-test-owner": name },
    async close() {
      if (closed) return;
      closed = true;
      await runtime.close();
      // HTTP closeAllConnections excludes upgrades, including a peer partway
      // through its closing handshake. Tear down fixture sockets explicitly.
      for (const socket of upgradedSockets) socket.destroy();
      await app.close();
      if (proxy) {
        proxy.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          proxy.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  };
}

async function rejectedSocket(url: string, token: string, instanceId: string) {
  const endpoint = new URL("api/node/socket", url);
  endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
  return new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(endpoint, {
      headers: { authorization: `Bearer ${token}`, "x-batty-instance-id": instanceId },
      handshakeTimeout: 5000,
    });
    socket.on("error", reject);
    socket.once("open", () => {
      socket.terminate();
      reject(new Error("Unauthorized socket unexpectedly opened"));
    });
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode!);
      socket.terminate();
    });
  });
}

async function connect(
  from: Awaited<ReturnType<typeof openInstance>>,
  to: Awaited<ReturnType<typeof openInstance>>,
) {
  const issued = await fetch(new URL("api/remotes", to.url), {
    method: "POST",
    headers: { ...to.owner, "content-type": "application/json" },
    body: JSON.stringify({ action: "token-generate" }),
  });
  expect(issued.status).toBe(200);
  const invitation = (await issued.json()) as { id: string; token: string };
  const connected = await fetch(new URL("api/remotes", from.url), {
    method: "POST",
    headers: { ...from.owner, "content-type": "application/json" },
    body: JSON.stringify({ action: "connection-add", url: to.url, token: invitation.token }),
  });
  expect(connected.status, await connected.text()).toBe(200);
  await eventually(
    async () =>
      from.runtime.remotes.reverse.status(to.id).state === "connected" &&
      to.runtime.remotes.reverse.status(from.id).state === "connected",
    "automatically paired socket connection",
  ).catch((error) => {
    throw new Error(
      `${error.message}: ${JSON.stringify({
        from: from.runtime.remotes.reverse.status(to.id),
        to: to.runtime.remotes.reverse.status(from.id),
      })}`,
      { cause: error },
    );
  });
  expect(from.runtime.remotes.access.listConnections()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: to.id,
        label: to.runtime.remotes.access.identity().name,
        reverseDial: true,
      }),
    ]),
  );
  expect(to.runtime.remotes.access.listConnections()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: from.id,
        label: from.runtime.remotes.access.identity().name,
        transport: "reverse",
      }),
    ]),
  );
  return invitation;
}

/** Only Mac dials Windows; its own URL never enters the pairing protocol. */
async function connectReverse(
  windows: Awaited<ReturnType<typeof openInstance>>,
  mac: Awaited<ReturnType<typeof openInstance>>,
) {
  return connect(mac, windows);
}

async function transcript(runtime: Runtime) {
  return runtime.main.commit(async (tx) => {
    const entries = [];
    let cursor;
    do {
      const page = await tx.scanEntries({ conversationId: runtime.main.id }, 200, cursor);
      entries.push(...page.items);
      cursor = page.next;
    } while (cursor);
    return JSON.stringify(entries);
  }, context);
}

function filesIn(value: unknown): SentFileDescriptor[] {
  if (Array.isArray(value)) return value.flatMap(filesIn);
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  if (typeof object.downloadUrl === "string" && typeof object.name === "string")
    return [object as unknown as SentFileDescriptor];
  return Object.values(object).flatMap(filesIn);
}

export {
  test,
  storageRoot,
  nodeRequest,
  eventually,
  openInstance,
  rejectedSocket,
  connect,
  connectReverse,
  transcript,
  filesIn,
};
