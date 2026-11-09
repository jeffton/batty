import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { workerCommandBody } from "./worker-files";
import { artifactRefs } from "./artifact-forwarding";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { expect, test, vi } from "vite-plus/test";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { loadConfig } from "./config";
import { Runtime, context } from "./runtime";
import { nodeRequest } from "./remote-workers";
import type { PairingClaim } from "./remote-access";
import { authenticateNode, registerRemoteRoutes } from "./routes/remotes";
import { registerReverseRemoteRoutes } from "./routes/reverse-remotes";
import { resolveSentFile, storeSentFiles } from "./send-files";
import type { SentFileDescriptor } from "../shared/types";

async function eventually(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function openInstance(directory: string, name: string, fileStatus = 200) {
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
  await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024 } });
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
  app.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/api/node/assignments/") && assignmentFailures > 0) {
      assignmentFailures--;
      failedAssignmentRequests++;
      return reply.code(503).send("Simulated transient assignment-status failure");
    }
    if (request.url.startsWith("/api/node/files/")) {
      fileRequests.push(request.url);
      // Model a proxy that decodes escaped separators before upstream routing.
      if (/%2f/i.test(request.url)) return reply.code(404).send("Proxy route not found");
      if (fileStatus !== 200) return reply.code(fileStatus).send("File unavailable");
    }
  });
  app.addHook("onRequest", async (request, reply) => {
    if (/^\/api\/node\/sessions\/\d+\/events(?:\?|$)/.test(request.url)) {
      const stream = { url: request.url, closed: false };
      sessionStreams.push(stream);
      reply.raw.once("close", () => {
        stream.closed = true;
      });
    }
  });
  // Match main.ts's independent node bearer boundary, using a fixture-only owner header.
  app.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/api/node/")) {
      return authenticateNode(request, reply, runtime.remotes.access);
    }
    if (request.headers["x-test-owner"] !== name)
      return reply.code(401).send({ error: "Owner authentication required" });
  });
  const closeRoutes = registerRemoteRoutes(app, runtime);
  registerReverseRemoteRoutes(app, runtime);
  const url = `${await app.listen({ host: "127.0.0.1", port: 0 })}/`;
  config.baseUrl = url;
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
    fileRequests,
    pairingClaims,
    setNodeOnline(online: boolean) {
      nodeOnline = online;
      if (!online) app.server.closeAllConnections();
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
      closeRoutes();
      await runtime.close();
      await app.close();
    },
  };
}

async function connect(
  from: Awaited<ReturnType<typeof openInstance>>,
  to: Awaited<ReturnType<typeof openInstance>>,
) {
  const issued = await to.app.inject({
    method: "POST",
    url: "/api/remotes",
    headers: to.owner,
    payload: { action: "token-generate" },
  });
  expect(issued.statusCode, issued.body).toBe(200);
  const invitation = issued.json<{ id: string; token: string }>();
  const connected = await from.app.inject({
    method: "POST",
    url: "/api/remotes",
    headers: from.owner,
    payload: { action: "connection-add", url: to.url, token: invitation.token },
  });
  expect(connected.statusCode, connected.body).toBe(200);
  await eventually(
    async () =>
      from.runtime.remotes.reverse.status(to.id).state === "connected" &&
      to.runtime.remotes.reverse.status(from.id).state === "connected",
    "automatically paired control connection",
  );
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

/** Only Mac dials Windows; Windows does not need to reach the advertised Mac URL. */
async function connectReverse(
  windows: Awaited<ReturnType<typeof openInstance>>,
  mac: Awaited<ReturnType<typeof openInstance>>,
  advertisedUrl = mac.url,
) {
  mac.config.baseUrl = advertisedUrl;
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

test("one invitation pairs both directions, never becomes a node bearer, and rejects replay or cross-binding", async () => {
  vi.stubEnv("PI_OFFLINE", "1");
  const directory = await mkdtemp(join(tmpdir(), "batty-single-invitation-"));
  const windows = await openInstance(directory, "windows");
  const mac = await openInstance(directory, "mac");
  const other = await openInstance(directory, "other");
  try {
    expect(
      (
        await windows.app.inject({
          method: "POST",
          url: "/api/remotes",
          payload: { action: "token-generate" },
        })
      ).statusCode,
    ).toBe(401);
    const bad = await mac.app.inject({
      method: "POST",
      url: "/api/remotes",
      headers: mac.owner,
      payload: { action: "connection-add", url: windows.url, token: "wrong-token" },
    });
    expect(bad.statusCode).toBe(500);
    expect(mac.runtime.remotes.access.listConnections()).toEqual([]);
    expect(windows.runtime.remotes.access.listConnections()).toEqual([]);

    const invitation = await connectReverse(windows, mac, "http://127.0.0.1:1/");
    expect(mac.id).toMatch(/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/);
    expect(windows.runtime.remotes.connection(mac.id).url).toBe("http://127.0.0.1:1/");
    expect(windows.runtime.remotes.access.identity().name).toMatch(
      new RegExp(` · ${windows.id.slice(0, 8)}$`),
    );
    const inviteAuth = { authorization: `Bearer ${invitation.token}` };
    expect(
      (await windows.app.inject({ url: "/api/node/identity", headers: inviteAuth })).statusCode,
    ).toBe(401);
    expect(
      (
        await windows.app.inject({
          method: "POST",
          url: "/api/node/commands",
          headers: inviteAuth,
          payload: { requestId: "invitation-is-not-bearer", command: { action: "list" } },
        })
      ).statusCode,
    ).toBe(401);
    // A lost HTTP response may retry exactly the durable original claim.
    const original = windows.pairingClaims[0]!;
    const retry = await windows.app.inject({
      method: "POST",
      url: "/api/node/pair",
      headers: inviteAuth,
      payload: original,
    });
    expect(retry.statusCode, retry.body).toBe(200);
    for (const claim of [
      { ...original, instanceId: other.id },
      { ...original, remoteToken: original.localToken },
      { ...original, localGrantId: "different-grant" },
    ]) {
      const replay = await windows.app.inject({
        method: "POST",
        url: "/api/node/pair",
        headers: inviteAuth,
        payload: claim,
      });
      expect(replay.statusCode).toBeGreaterThanOrEqual(400);
    }
    await connect(other, windows);
    const otherToken = other.runtime.remotes.connection(windows.id).token;
    expect(
      (
        await windows.app.inject({
          url: "/api/node/reverse/control",
          headers: { authorization: `Bearer ${otherToken}`, "x-batty-instance-id": mac.id },
        })
      ).statusCode,
    ).toBe(403);
    const unused = await windows.app.inject({
      method: "POST",
      url: "/api/remotes",
      headers: windows.owner,
      payload: { action: "token-generate" },
    });
    const revoked = await windows.app.inject({
      method: "POST",
      url: "/api/remotes",
      headers: windows.owner,
      payload: { action: "token-revoke", id: unused.json().id },
    });
    expect(revoked.statusCode).toBe(200);
    const claimedRevoked = await windows.app.inject({
      method: "POST",
      url: "/api/node/pair",
      headers: { authorization: `Bearer ${unused.json().token}` },
      payload: { ...original, instanceId: "new-peer" },
    });
    expect(claimedRevoked.statusCode).toBe(401);
    await eventually(
      async () => windows.runtime.remotes.reverse.status(mac.id).state === "connected",
      "unused invitation revocation preserves paired peers",
    );
    for (const [from, to] of [
      [windows, mac],
      [mac, windows],
    ] as const) {
      to.faux.setResponses([fauxAssistantMessage([fauxText(`executed on ${to.id}`)])]);
      const started = await nodeRequest<{ output: Array<{ text: string }> }>(
        from.runtime.remotes.connection(to.id),
        "commands",
        {
          method: "POST",
          body: JSON.stringify({
            requestId: `paired-${from.id}`,
            command: {
              action: "run",
              workspaceId: "work",
              prompt: "prove both directions",
            },
          }),
        },
        from.runtime.remotes.requestNode,
      );
      expect(started.output[0]!.text).toContain("Started");
      await eventually(
        async () => (await to.runtime.orchestration.listRunning()).length === 0,
        "paired native worker completion",
      );
    }
    expect(await windows.runtime.orchestration.queryWorkers({ action: "list" })).toHaveProperty(
      "output",
    );
    const publicState = await windows.app.inject({ url: "/api/remotes", headers: windows.owner });
    expect(publicState.body).not.toContain(invitation.token);
    expect(publicState.body).not.toContain(original.localToken);
    expect(publicState.body).not.toContain(original.remoteToken);
    expect(publicState.body).not.toContain("localGrantId");
    expect(publicState.body).not.toContain("claimHash");
  } finally {
    await other.close();
    await mac.close();
    await windows.close();
    await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
}, 30_000);

test.each(["creator", "adder"] as const)(
  "offline removal by %s revokes access without restarting a worker or repairing itself",
  async (removingSide) => {
    vi.stubEnv("PI_OFFLINE", "1");
    const directory = await mkdtemp(join(tmpdir(), "batty-offline-unpair-"));
    const windows = await openInstance(directory, "windows");
    const mac = await openInstance(directory, "mac");
    try {
      await connectReverse(windows, mac, "http://127.0.0.1:1/");
      mac.faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall("bash", {
              command:
                "printf ready > entered; for i in $(seq 1 400); do test -f release && exit 0; sleep 0.05; done; exit 1",
            }),
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage([fauxText("independent worker completed")]),
      ]);
      const connection = windows.runtime.remotes.connection(mac.id);
      const started = await nodeRequest<{ output: Array<{ text: string }> }>(
        connection,
        "commands",
        {
          method: "POST",
          body: JSON.stringify({
            requestId: "offline-unpair-worker",
            command: { action: "run", workspaceId: "work", prompt: "continue while disconnected" },
          }),
        },
        windows.runtime.remotes.requestNode,
      );
      const session = /Session ID: (\d+)/.exec(started.output[0]!.text)![1]!;
      await eventually(async () => {
        try {
          return (await readFile(join(mac.work, "entered"), "utf8")) === "ready";
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
      }, "worker began before network outage");
      windows.setNodeOnline(false);
      await eventually(
        async () => mac.runtime.remotes.reverse.status(windows.id).state !== "connected",
        "simulated standby",
      );
      const removing = removingSide === "creator" ? windows : mac;
      const peer = removingSide === "creator" ? mac : windows;
      const staleToken = peer.runtime.remotes.connection(removing.id).token;
      const removed = await removing.app.inject({
        method: "POST",
        url: "/api/remotes",
        headers: removing.owner,
        payload: { action: "connection-remove", id: peer.id },
      });
      expect(removed.statusCode, removed.body).toBe(200);
      expect(removing.runtime.remotes.access.getConnection(peer.id)).toBeUndefined();
      windows.setNodeOnline(true);
      expect(
        (
          await removing.app.inject({
            url: "/api/node/identity",
            headers: { authorization: `Bearer ${staleToken}` },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await removing.app.inject({
            url: "/api/node/reverse/control",
            headers: { authorization: `Bearer ${staleToken}`, "x-batty-instance-id": peer.id },
          })
        ).statusCode,
      ).toBe(401);
      expect(removing.runtime.remotes.access.listConnections()).toEqual([]);
      expect(await mac.runtime.orchestration.listRunning()).toHaveLength(1);
      await writeFile(join(mac.work, "release"), "release");
      await eventually(
        async () => (await mac.runtime.orchestration.listRunning()).length === 0,
        "original worker completes after unpair",
      );
      const workers = await mac.runtime.orchestration.queryWorkers({ action: "list" });
      expect(JSON.parse(workers.output[0]!.text).workers).toEqual([
        expect.objectContaining({ sessionId: session, status: "completed" }),
      ]);
      expect(removing.runtime.remotes.access.listConnections()).toEqual([]);
    } finally {
      await writeFile(join(mac.work, "release"), "release");
      await mac.close();
      await windows.close();
      await rm(directory, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  },
  30_000,
);

test.each(["reverse-unpair", "control-loss"] as const)(
  "direct paired catalog and session streams close on %s",
  async (interruption) => {
    vi.stubEnv("PI_OFFLINE", "1");
    const directory = await mkdtemp(join(tmpdir(), "batty-paired-direct-streams-"));
    const windows = await openInstance(directory, "windows");
    const mac = await openInstance(directory, "mac");
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    const controllers: AbortController[] = [];
    try {
      await connectReverse(windows, mac);
      mac.faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall("bash", {
              command:
                "printf ready > entered; for i in $(seq 1 400); do test -f release && exit 0; sleep 0.05; done; exit 1",
            }),
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage([fauxText("work survives stream cancellation")]),
      ]);
      const connection = windows.runtime.remotes.connection(mac.id);
      const started = await nodeRequest<{ output: Array<{ text: string }> }>(
        connection,
        "commands",
        {
          method: "POST",
          body: JSON.stringify({
            requestId: "paired-stream-worker",
            command: { action: "run", workspaceId: "work", prompt: "hold while streams close" },
          }),
        },
        windows.runtime.remotes.requestNode,
      );
      const session = /Session ID: (\d+)/.exec(started.output[0]!.text)![1]!;
      for (const route of ["catalog/events", `sessions/${session}/events`]) {
        const controller = new AbortController();
        controllers.push(controller);
        // These are independent inbound direct HTTP streams, not reverse transfers
        // and not outgoing RemoteWorkers subscribers whose abort could hide a leak.
        const response = await fetch(new URL(`api/node/${route}`, mac.url), {
          headers: { authorization: `Bearer ${connection.token}` },
          signal: controller.signal,
        });
        expect(response.status).toBe(200);
        const reader = response.body!.getReader();
        readers.push(reader);
        expect((await reader.read()).done).toBe(false);
      }
      const closed = readers.map(async (reader) => {
        try {
          while (!(await reader.read()).done) {}
        } catch (error) {
          if (!(error instanceof TypeError)) throw error;
        }
      });
      if (interruption === "reverse-unpair") {
        const removed = await windows.app.inject({
          method: "POST",
          url: "/api/remotes",
          headers: windows.owner,
          payload: { action: "connection-remove", id: mac.id },
        });
        expect(removed.statusCode, removed.body).toBe(200);
      } else {
        // Interrupt only the other listener: these independent inbound sockets on
        // Mac remain open unless its paired-control lifecycle explicitly closes them.
        windows.setNodeOnline(false);
        await windows.runtime.remotes.reverse.close();
      }
      await Promise.all(closed);
      await eventually(
        async () => mac.sessionStreams.every((stream) => stream.closed),
        "independent inbound session SSE retired",
      );
      expect(
        (
          await mac.app.inject({
            url: "/api/node/identity",
            headers: { authorization: `Bearer ${connection.token}` },
          })
        ).statusCode,
      ).toBe(interruption === "reverse-unpair" ? 401 : 503);
      expect(await mac.runtime.orchestration.listRunning()).toHaveLength(1);
    } finally {
      for (const controller of controllers) controller.abort();
      for (const reader of readers) await reader.cancel().catch(() => {});
      await writeFile(join(mac.work, "release"), "release");
      await mac.close();
      await windows.close();
      await rm(directory, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  },
  30_000,
);

test("session SSE rechecks paired access after asynchronous metadata lookup", async () => {
  vi.stubEnv("PI_OFFLINE", "1");
  const directory = await mkdtemp(join(tmpdir(), "batty-paired-sse-admission-"));
  const windows = await openInstance(directory, "windows");
  const mac = await openInstance(directory, "mac");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let restore: (() => void) | undefined;
  try {
    await connectReverse(windows, mac);
    mac.faux.setResponses([fauxAssistantMessage([fauxText("SSE admission evidence")])]);
    const connection = windows.runtime.remotes.connection(mac.id);
    const started = await nodeRequest<{ output: Array<{ text: string }> }>(
      connection,
      "commands",
      {
        method: "POST",
        body: JSON.stringify({
          requestId: "sse-admission-worker",
          command: { action: "run", workspaceId: "work", prompt: "complete before SSE request" },
        }),
      },
      windows.runtime.remotes.requestNode,
    );
    const session = /Session ID: (\d+)/.exec(started.output[0]!.text)![1]!;
    await eventually(
      async () => (await mac.runtime.orchestration.listRunning()).length === 0,
      "worker completion before paused admission",
    );
    await eventually(
      async () =>
        windows.runtime.remotes
          .list()
          .some(
            (worker) =>
              worker.sessionId === `remote:${mac.id}:${session}` && worker.status === "completed",
          ) &&
        mac.sessionStreams.length > 0 &&
        mac.sessionStreams.every((stream) => stream.closed),
      "background mirror finished its session admission before the controlled request",
    );
    const metadata = mac.runtime.orchestration.metadata.bind(mac.runtime.orchestration);
    const spy = vi
      .spyOn(mac.runtime.orchestration, "metadata")
      .mockImplementation(async (...args) => {
        const result = await metadata(...args);
        if (String(args[0]) === session) {
          entered.resolve();
          await release.promise;
        }
        return result;
      });
    restore = () => spy.mockRestore();
    const admissionPath = `/api/node/sessions/${session}/events?after=0&admission-test=1`;
    const pending = fetch(new URL(admissionPath, mac.url), {
      headers: { authorization: `Bearer ${connection.token}` },
      signal: AbortSignal.timeout(10_000),
    });
    await entered.promise;
    const removed = await windows.app.inject({
      method: "POST",
      url: "/api/remotes",
      headers: windows.owner,
      payload: { action: "connection-remove", id: mac.id },
    });
    expect(removed.statusCode, removed.body).toBe(200);
    // Creator removal writes an unpair control event, not an acknowledged RPC.
    // Keep metadata paused until the receiving peer has persisted revocation.
    await eventually(
      async () => mac.runtime.remotes.access.getConnection(windows.id) === undefined,
      "receiving peer persisted unpair before session admission resumes",
    );
    release.resolve();
    const response = await pending;
    expect(response.status).toBe(401);
    await response.body?.cancel();
    const admissions = mac.sessionStreams.filter((stream) => stream.url === admissionPath);
    expect(admissions).toHaveLength(1);
    await eventually(async () => admissions[0]!.closed, "rejected admission request closed");
  } finally {
    release.resolve();
    restore?.();
    await mac.close();
    await windows.close();
    await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
}, 30_000);

test("bidirectional peers discover independently started workers without claiming them in Tasks", async () => {
  vi.stubEnv("PI_OFFLINE", "1");
  const directory = await mkdtemp(join(tmpdir(), "batty-peer-task-ownership-"));
  const instances: Awaited<ReturnType<typeof openInstance>>[] = [];
  try {
    const a = await openInstance(directory, "a");
    instances.push(a);
    const b = await openInstance(directory, "b");
    instances.push(b);
    await connect(a, b);

    for (const instance of instances) {
      instance.faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall("bash", {
              command:
                "printf ready > entered; for i in $(seq 1 400); do test -f release && exit 0; sleep 0.05; done; exit 1",
            }),
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage([fauxText("Independent work finished")]),
      ]);
      // Start on this runtime, without a delegation/assignment from its connected peer.
      const started = await instance.runtime.orchestration.nodeCommand("independent", "start", {
        action: "run",
        workspaceId: "work",
        prompt: "independent worker",
      });
      expect(started.isError).not.toBe(true);
    }
    await eventually(
      async () =>
        a.runtime.remotes.list().some((worker) => worker.status === "running") &&
        b.runtime.remotes.list().some((worker) => worker.status === "running"),
      "both peer catalogs",
    );
    expect(a.runtime.remotes.tasks(a.runtime.main.id)).toEqual([]);
    expect(b.runtime.remotes.tasks(b.runtime.main.id)).toEqual([]);
  } finally {
    for (const instance of instances) await writeFile(join(instance.work, "release"), "release");
    for (const instance of instances) {
      await eventually(
        async () => (await instance.runtime.orchestration.listRunning()).length === 0,
        "independent worker shutdown",
      );
      await instance.runtime.main.waitForIdle(context);
      await instance.close();
    }
    await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
}, 45_000);

test.each(["http", "reverse"] as const)(
  "%s peers execute remote native tools, deliver progress to the initiating parent, and retain local history/files offline",
  async (transport) => {
    vi.stubEnv("PI_OFFLINE", "1");
    const directory = await mkdtemp(join(tmpdir(), "batty-two-runtimes-"));
    let a: Awaited<ReturnType<typeof openInstance>> | undefined;
    let b: Awaited<ReturnType<typeof openInstance>> | undefined;
    try {
      a = await openInstance(directory, "a");
      b = await openInstance(directory, "b");
      const local = a;
      const remote = b;
      if (transport === "reverse") await connectReverse(local, remote);
      else {
        await connect(local, remote);
      }
      let bModelCalls = 0;
      remote.faux.setResponses([
        (request) => {
          bModelCalls++;
          expect(JSON.stringify(request.messages)).toContain(
            "Unique instance b workspace guidance.",
          );
          expect(JSON.stringify(request.messages)).not.toContain(
            "Unique instance a workspace guidance.",
          );
          expect(getCurrentTools(request.messages).map((tool) => tool.name)).toEqual(
            expect.arrayContaining(["read", "bash", "attach_files", "subagent"]),
          );
          return fauxAssistantMessage([fauxToolCall("read", { path: "origin.txt" })], {
            stopReason: "toolUse",
          });
        },
        (request) => {
          bModelCalls++;
          expect(JSON.stringify(request.messages)).toContain("tools executed on b");
          expect(JSON.stringify(request.messages)).not.toContain("tools executed on a");
          return fauxAssistantMessage(
            [{ ...fauxToolCall("attach_files", { paths: ["origin.txt"] }), id: "call/attachment" }],
            {
              stopReason: "toolUse",
            },
          );
        },
        fauxAssistantMessage(
          [fauxToolCall("subagent", { action: "report", prompt: "B progress with evidence" })],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage(
          [
            fauxToolCall("bash", {
              command:
                "printf ready > entered; for i in $(seq 1 400); do test -f release && exit 0; sleep 0.05; done; exit 1",
            }),
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage([fauxText("B final complete")]),
      ]);
      let localStarted = false;
      local.faux.setResponses(
        Array.from({ length: 20 }, () => (request) => {
          if (!localStarted) {
            localStarted = true;
            return fauxAssistantMessage(
              [
                fauxToolCall("subagent", {
                  action: "run",
                  nodeId: remote.id,
                  workspaceId: "work",
                  prompt: "Read origin.txt, attach evidence, report progress and finish",
                }),
              ],
              { stopReason: "toolUse" },
            );
          }
          const last = request.messages.findLast((message) => message.role !== "system");
          if (last?.role === "toolResult" && last.toolName === "subagent") {
            const remoteId = /Started[^]*?Session ID: (remote:[\w-]+:\d+)/.exec(
              JSON.stringify(last),
            )?.[1];
            if (remoteId)
              return fauxAssistantMessage(
                [fauxToolCall("subagent", { action: "await", sessionId: remoteId })],
                { stopReason: "toolUse" },
              );
          }
          return fauxAssistantMessage([fauxText("A observed remote activity")]);
        }),
      );
      await (
        await local.runtime.main.submit(
          { type: "input", content: "Start remote integration" },
          context,
        )
      ).wait(context);
      await eventually(async () => {
        try {
          return (await readFile(join(remote.work, "entered"), "utf8")) === "ready";
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
      }, "B's native bash tool");
      expect(bModelCalls).toBe(2);
      expect(await transcript(local.runtime)).toContain("Awaiting subagent");
      await eventually(
        async () => (await transcript(local.runtime)).includes("B progress with evidence"),
        "streamed progress on A",
      );
      expect((await remote.runtime.main.context(context)).messages).toHaveLength(0);
      const running = local.runtime.remotes.list();
      expect(running).toHaveLength(1);
      const id = running[0]!.sessionId;
      expect(id.split(":")).toEqual(["remote", remote.id, expect.stringMatching(/^\d+$/)]);
      await eventually(
        async () =>
          local.runtime.remotes.tasks(local.runtime.main.id).some((row) => row.sessionId === id),
        "remote Tasks row",
      );
      // A connection in the reverse direction must not change task ownership.
      expect(remote.runtime.remotes.tasks(remote.runtime.main.id)).toEqual([]);
      expect(local.runtime.remotes.tasks(local.runtime.main.id + 1)).toEqual([]);
      const state = await local.runtime.state(id);
      expect(state.cwd).toBe(remote.work);
      expect(state.model).toBe("faux/model-b");
      expect(state.isStreaming).toBe(true);
      const worker = await remote.runtime.conversation(id.split(":")[2]!);
      expect((await worker.agent(context)).cwd).toBe(remote.work);
      expect((await worker.agent(context)).model).toMatchObject({ modelId: "model-b" });

      // A status request can fail after the last terminal catalog commit; reconnect must resync it.
      remote.failNextAssignmentRequest();
      // Interrupt real HTTP control/data sockets; the Mac worker must continue independently.
      if (transport === "reverse") local.app.server.closeAllConnections();
      else local.runtime.remotes.disconnect(remote.id);
      await writeFile(join(remote.work, "release"), "release");
      await eventually(
        async () => (await remote.runtime.orchestration.listRunning()).length === 0,
        "B finishing during stream disconnect",
      );
      if (transport === "http") local.runtime.remotes.connect(remote.id);
      await eventually(
        async () => remote.failedAssignmentRequests() === 1,
        "injected assignment-status failure consumed independently of session replay",
      );
      await eventually(
        async () => (await transcript(local.runtime)).includes("B final complete"),
        "final result on A",
      );
      await eventually(
        async () => local.runtime.remotes.list()[0]?.status === "completed",
        "completed catalog state",
      );
      expect((await remote.runtime.main.context(context)).messages).toHaveLength(0);
      const delivered = await transcript(local.runtime);
      expect(delivered.match(/B progress with evidence/g)).toHaveLength(1);
      expect(delivered.match(/B final complete/g)).toHaveLength(1);
      expect(remote.failedAssignmentRequests()).toBe(1);
      await eventually(async () => {
        const joins = await local.runtime.main.commit(
          (tx) =>
            tx.scanTasks({ conversationId: local.runtime.main.id, kind: "batty.remote-join" }, 100),
          context,
        );
        return (
          joins.items.length === 1 &&
          joins.items.every(
            (task) => task.state.status === "terminal" && task.state.outcome.status === "completed",
          )
        );
      }, "durable await task completed after status resync, not merely session delivery");
      await eventually(
        async () => JSON.stringify(local.runtime.remotes.messages(id)).includes("B final complete"),
        "terminal session history caught up independently of assignment result",
      );
      const history = local.runtime.remotes.messages(id);
      expect(JSON.stringify(history)).toContain("B final complete");
      const copied = filesIn(history).find((file) => file.name === "origin.txt");
      expect(copied).toBeDefined();
      expect(remote.fileRequests.length).toBeGreaterThan(0);
      expect(remote.fileRequests.every((url) => !/%2f/i.test(url))).toBe(true);
      expect(copied!.downloadUrl).toContain(`/api/sent-files/remote-${remote.id}/`);
      const segments = new URL(copied!.downloadUrl, local.url).pathname
        .split("/")
        .slice(-4)
        .map(decodeURIComponent);
      const stored = await resolveSentFile({
        rootDir: local.config.sentFilesDir,
        workspaceId: segments[0]!,
        sessionId: segments[1]!,
        toolCallId: segments[2]!,
        fileId: segments[3]!,
      });
      await remote.close();
      local.runtime.remotes.disconnect(remote.id);
      expect(await readFile(stored.storedPath, "utf8")).toBe("tools executed on b");
      expect(JSON.stringify(local.runtime.remotes.messages(id))).toContain("B final complete");
      await local.close();
      // Reopen A without reconnecting to B: projections and bytes are local durable state.
      const reopened = await Runtime.open(local.config, { resume: false });
      try {
        reopened.remotes.disconnect(remote.id);
        expect(JSON.stringify(reopened.remotes.messages(id))).toContain("B final complete");
        expect(await readFile(stored.storedPath, "utf8")).toBe("tools executed on b");
      } finally {
        await reopened.close();
      }
    } finally {
      if (b) await writeFile(join(b.work, "release"), "release");
      await a?.close();
      await b?.close();
      await rm(directory, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  },
  45_000,
);

test("reverse-only unreachable Mac address supports discovery, native workers, inspect, await and stop", async () => {
  vi.stubEnv("PI_OFFLINE", "1");
  const directory = await mkdtemp(join(tmpdir(), "batty-reverse-only-"));
  let windows: Awaited<ReturnType<typeof openInstance>> | undefined;
  let mac: Awaited<ReturnType<typeof openInstance>> | undefined;
  try {
    windows = await openInstance(directory, "a");
    mac = await openInstance(directory, "b");
    const local = windows;
    const remote = mac;
    // There is no listener here: any accidental HTTP fallback makes this test fail.
    await connectReverse(local, remote, "http://127.0.0.1:1/");
    const discovered = await local.runtime.remotes.workspaces(remote.id);
    expect(discovered[0]).toMatchObject({
      nodeId: remote.id,
      defaultModel: "faux/model-b",
      workspaces: [expect.objectContaining({ id: "work" })],
    });
    remote.faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("bash", {
            command:
              "printf ready > entered; for i in $(seq 1 400); do test -f release && exit 0; sleep 0.05; done; exit 1",
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("worker released")]),
    ]);
    const request = <T>(route: string, init: RequestInit = {}) =>
      nodeRequest<T>(
        local.runtime.remotes.connection(remote.id),
        route,
        init,
        local.runtime.remotes.requestNode,
      );
    const command = <T>(requestId: string, action: Record<string, unknown>) =>
      request<T>("commands", {
        method: "POST",
        body: JSON.stringify({ requestId, command: action }),
      });
    const run = { action: "run", workspaceId: "work", prompt: "native reverse-only worker" };
    const started = await command<{ output: Array<{ text: string }> }>("reverse-once", run);
    const session = /Session ID: (\d+)/.exec(started.output[0]!.text)![1]!;
    const duplicate = await command("reverse-once", run);
    expect(duplicate).toEqual(started);
    await eventually(async () => {
      try {
        return (await readFile(join(remote.work, "entered"), "utf8")) === "ready";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    }, "reverse-only native bash worker");
    const inspected = await command<{ output: Array<{ text: string }> }>("reverse-inspect", {
      action: "inspect",
      sessionId: session,
    });
    expect(JSON.parse(inspected.output[0]!.text)).toMatchObject({
      sessionId: session,
      status: "running",
    });
    const waiting = await command<{ details: { assignmentId: string } }>("reverse-await", {
      action: "await",
      sessionId: session,
    });
    const controller = new AbortController();
    const joined = local.runtime.remotes.join(
      {
        node: remote.id,
        session,
        assignmentId: waiting.details.assignmentId,
        parentId: local.runtime.main.id,
      },
      controller.signal,
    );
    try {
      await local.runtime.remotes.stop(`remote:${remote.id}:${session}`);
      await joined;
      await eventually(
        async () => (await remote.runtime.orchestration.listRunning()).length === 0,
        "stopped remote worker",
      );
      const after = await command<{ output: Array<{ text: string }> }>("reverse-inspect-stopped", {
        action: "inspect",
        sessionId: session,
      });
      expect(JSON.parse(after.output[0]!.text).status).not.toBe("running");
      expect(await transcript(local.runtime)).toContain(`remote:${remote.id}:${session}`);
      const installation = remote.runtime.remotes.access.identity().instanceId;
      await remote.close();
      await eventually(
        async () => local.runtime.remotes.reverse.status(remote.id).state !== "connected",
        "closed Mac transport becoming unavailable",
      );
      mac = await openInstance(directory, "b");
      expect(mac.runtime.remotes.access.identity().instanceId).toBe(installation);
      const reopened = mac;
      await eventually(
        async () =>
          local.runtime.remotes.reverse.status(remote.id).state === "connected" &&
          reopened.runtime.remotes.reverse.status(local.id).state === "connected",
        "persisted Mac pairing reconnecting after Runtime/server restart",
      );
      const restored = await command<{ output: Array<{ text: string }> }>("reverse-restored", {
        action: "inspect",
        sessionId: session,
      });
      expect(JSON.parse(restored.output[0]!.text)).toMatchObject({ sessionId: session });
      expect((await local.runtime.remotes.workspaces(remote.id))[0]!.defaultModel).toBe(
        "faux/model-b",
      );
      const catalog = await reopened.runtime.orchestration.queryWorkers({ action: "list" });
      expect(JSON.parse(catalog.output[0]!.text).workers).toHaveLength(1);
    } finally {
      controller.abort();
      await joined.catch(() => {});
    }
  } finally {
    if (mac) await writeFile(join(mac.work, "release"), "release");
    await windows?.close();
    await mac?.close();
    await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
}, 30_000);

test("reverse pairing rejects impersonation and live grant revocation severs streams without queuing offline commands", async () => {
  vi.stubEnv("PI_OFFLINE", "1");
  const directory = await mkdtemp(join(tmpdir(), "batty-reverse-revoke-"));
  let windows: Awaited<ReturnType<typeof openInstance>> | undefined;
  let mac: Awaited<ReturnType<typeof openInstance>> | undefined;
  try {
    windows = await openInstance(directory, "a");
    mac = await openInstance(directory, "b");
    const local = windows;
    const remote = mac;
    await connectReverse(local, remote);
    const identity = remote.runtime.remotes.access.identity().instanceId;
    const dialToken = remote.runtime.remotes.connection(local.id).token;
    const control = (token: string, instance: string) =>
      local.app.inject({
        url: "/api/node/reverse/control",
        headers: { authorization: `Bearer ${token}`, "x-batty-instance-id": instance },
      });
    expect((await control("wrong-token", identity)).statusCode).toBe(401);
    expect((await control(dialToken, "untrusted-installation")).statusCode).toBe(403);

    const otherGrant = await local.runtime.remotes.access.issueInvitation();
    expect((await control(dialToken, "other-installation")).statusCode).toBe(403);
    expect((await control(otherGrant.token, identity)).statusCode).toBe(401);
    await eventually(
      async () => local.runtime.remotes.reverse.status(remote.id).state === "connected",
      "legitimate pairing remains connected",
    );

    remote.faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("subagent", {
            action: "report",
            prompt: "Auth regression progress",
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        [
          fauxToolCall("bash", {
            command:
              "printf ready > entered; for i in $(seq 1 400); do test -f release && exit 0; sleep 0.05; done; exit 1",
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("auth regression complete")]),
    ]);
    const connection = local.runtime.remotes.connection(remote.id);
    const started = await nodeRequest<{ output: Array<{ text: string }> }>(
      connection,
      "commands",
      {
        method: "POST",
        body: JSON.stringify({
          requestId: "auth-regression-run",
          command: { action: "run", workspaceId: "work", prompt: "report progress and hold" },
        }),
      },
      local.runtime.remotes.requestNode,
    );
    const session = /Session ID: (\d+)/.exec(started.output[0]!.text)![1]!;
    const id = `remote:${remote.id}:${session}`;
    await eventually(async () => {
      try {
        return (
          (await readFile(join(remote.work, "entered"), "utf8")) === "ready" &&
          JSON.stringify(local.runtime.remotes.messages(id)).includes("Auth regression progress")
        );
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code === "ENOENT" ||
          (error as { statusCode?: number }).statusCode === 404
        )
          return false;
        throw error;
      }
    }, "progress mirrored before revocation");
    const waiting = await nodeRequest<{ details: { assignmentId: string } }>(
      connection,
      "commands",
      {
        method: "POST",
        body: JSON.stringify({
          requestId: "auth-regression-await",
          command: { action: "await", sessionId: session },
        }),
      },
      local.runtime.remotes.requestNode,
    );
    const revokedAwaitAbort = new AbortController();
    const revokedJoin = local.runtime.remotes.join(
      {
        node: remote.id,
        session,
        assignmentId: waiting.details.assignmentId,
        parentId: local.runtime.main.id,
      },
      revokedAwaitAbort.signal,
    );
    const live = await local.runtime.remotes.requestNode(connection, "catalog/events");
    const reader = live.body!.getReader();
    await reader.read();
    const pendingRead = reader.read();
    const interrupted = expect(pendingRead).rejects.toThrow();
    const channel = local.runtime.remotes.reverse.channel(connection);
    expect(channel.transfers.size).toBeGreaterThan(0);
    // Internal credential loss must fail closed, independently of owner removal.
    await local.runtime.remotes.access.revoke(connection.reverseGrantId!);
    local.runtime.remotes.reverse.reconfigure();
    await interrupted;
    try {
      await revokedJoin;
      expect(await transcript(local.runtime)).toContain("revoked");
      expect(local.runtime.remotes.access.getConnection(remote.id)).toBeDefined();
    } finally {
      revokedAwaitAbort.abort();
      await revokedJoin.catch(() => {});
    }
    expect(channel.transfers.size).toBe(0);
    expect((await control(dialToken, identity)).statusCode).toBe(401);
    await eventually(
      async () => local.runtime.remotes.state(id).remote?.connectionState === "offline",
      "retained mirror explicitly offline",
    );
    expect(JSON.stringify(local.runtime.remotes.messages(id))).toContain(
      "Auth regression progress",
    );
    const api = {
      conversationId: local.runtime.main.id,
      taskId: 991,
    } as unknown as Parameters<typeof local.runtime.remotes.command>[1];
    const inspected = await local.runtime.remotes.command(
      { action: "inspect", sessionId: id },
      api,
      context,
    );
    expect(JSON.parse(inspected.output[0]!.text)).toMatchObject({
      sessionId: id,
      status: "running",
      connectionState: "offline",
    });
    const forbiddenStop = local.runtime.remotes.stop(id);
    await expect(forbiddenStop).rejects.toThrow(/revoked/);
    await expect(forbiddenStop).rejects.toMatchObject({ status: 403 });
    await expect(
      local.runtime.remotes.command(
        {
          action: "steer",
          sessionId: id,
          prompt: "must not queue offline",
        },
        api,
        context,
      ),
    ).rejects.toThrow(/revoked/);
    expect(await remote.runtime.orchestration.listRunning()).toHaveLength(1);
    expect(
      JSON.stringify(await (await remote.runtime.conversation(session)).context(context)),
    ).not.toContain("must not queue offline");
    await reader.cancel().catch(() => {});
  } finally {
    if (mac) await writeFile(join(mac.work, "release"), "release");
    await windows?.close();
    await mac?.close();
    await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
}, 30_000);

test("pending remote await settles after connection removal persistence without another remote commit", async () => {
  vi.stubEnv("PI_OFFLINE", "1");
  const directory = await mkdtemp(join(tmpdir(), "batty-remote-remove-await-"));
  let windows: Awaited<ReturnType<typeof openInstance>> | undefined;
  let mac: Awaited<ReturnType<typeof openInstance>> | undefined;
  try {
    windows = await openInstance(directory, "a");
    mac = await openInstance(directory, "b");
    const local = windows;
    const remote = mac;
    await connect(local, remote);
    remote.faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("bash", {
            command:
              "printf ready > entered; for i in $(seq 1 400); do test -f release && exit 0; sleep 0.05; done; exit 1",
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("released removal regression")]),
    ]);
    const connection = local.runtime.remotes.connection(remote.id);
    const command = <T>(requestId: string, body: Record<string, unknown>) =>
      nodeRequest<T>(
        connection,
        "commands",
        {
          method: "POST",
          body: JSON.stringify({ requestId, command: body }),
        },
        local.runtime.remotes.requestNode,
      );
    const started = await command<{ output: Array<{ text: string }> }>("removal-run", {
      action: "run",
      workspaceId: "work",
      prompt: "hold while parent connection is removed",
    });
    const session = /Session ID: (\d+)/.exec(started.output[0]!.text)![1]!;
    const waiting = await command<{ details: { assignmentId: string } }>("removal-await", {
      action: "await",
      sessionId: session,
    });
    // Removing a connection must wake a durable await after persistence, not before.
    const joinAbort = new AbortController();
    let joined = false;
    const pendingJoin = local.runtime.remotes
      .join(
        {
          node: remote.id,
          session,
          assignmentId: waiting.details.assignmentId,
          parentId: local.runtime.main.id,
        },
        joinAbort.signal,
      )
      .then(() => {
        joined = true;
      });
    let releaseRemoval!: () => void;
    const removalGate = new Promise<void>((resolve) => {
      releaseRemoval = resolve;
    });
    let enteredRemoval!: () => void;
    const removalEntered = new Promise<void>((resolve) => {
      enteredRemoval = resolve;
    });
    const originalRemove = local.runtime.remotes.access.removeConnection.bind(
      local.runtime.remotes.access,
    );
    const remove = vi
      .spyOn(local.runtime.remotes.access, "removeConnection")
      .mockImplementation(async (node) => {
        enteredRemoval();
        await removalGate;
        return originalRemove(node);
      });
    try {
      const removing = local.app
        .inject({
          method: "POST",
          url: "/api/remotes",
          headers: local.owner,
          payload: { action: "connection-remove", id: remote.id },
        })
        .then((response) => response);
      await removalEntered;
      expect(local.runtime.remotes.access.getConnection(remote.id)).toBeDefined();
      expect(joined).toBe(false);
      releaseRemoval();
      expect((await removing).statusCode).toBe(200);
      await pendingJoin;
      expect(await transcript(local.runtime)).toContain(`Unknown remote instance: ${remote.id}`);
      expect(local.runtime.remotes.access.getConnection(remote.id)).toBeUndefined();
    } finally {
      releaseRemoval();
      joinAbort.abort();
      await pendingJoin.catch(() => {});
      remove.mockRestore();
    }
  } finally {
    if (mac) await writeFile(join(mac.work, "release"), "release");
    await windows?.close();
    await mac?.close();
    await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
}, 30_000);

// A permanent miss and a retryable failure exercise the two import/recovery paths.
test.each([404, 503])(
  "HTTP %i file failures do not strand a coordinator's remote await or terminal mirror",
  async (status) => {
    vi.stubEnv("PI_OFFLINE", "1");
    const directory = await mkdtemp(join(tmpdir(), "batty-remote-import-failure-"));
    let a: Awaited<ReturnType<typeof openInstance>> | undefined;
    let b: Awaited<ReturnType<typeof openInstance>> | undefined;
    try {
      a = await openInstance(directory, "a");
      b = await openInstance(directory, "b", status);
      const local = a;
      const remote = b;
      await connect(local, remote);
      remote.faux.setResponses([
        fauxAssistantMessage([fauxToolCall("attach_files", { paths: ["origin.txt"] })], {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage(
          [
            fauxToolCall("bash", {
              command:
                "printf ready > entered; for i in $(seq 1 400); do test -f release && exit 0; sleep 0.05; done; exit 1",
            }),
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage([fauxText("Remote final despite missing attachment")]),
      ]);
      let started = false;
      let remoteStarted = false;
      let receivedImportFailure = false;
      local.faux.setResponses(
        Array.from({ length: 30 }, () => (request) => {
          if (!started) {
            started = true;
            return fauxAssistantMessage(
              [
                fauxToolCall("subagent", {
                  action: "run",
                  workspaceId: "work",
                  prompt: "Coordinate remote evidence",
                }),
              ],
              { stopReason: "toolUse" },
            );
          }
          const last = request.messages.findLast((message) => message.role !== "system");
          if (
            last?.role === "user" &&
            JSON.stringify(last).includes("Coordinate remote evidence") &&
            !remoteStarted
          ) {
            remoteStarted = true;
            return fauxAssistantMessage(
              [
                fauxToolCall("subagent", {
                  action: "run",
                  nodeId: remote.id,
                  workspaceId: "work",
                  prompt: "Attach evidence and finish",
                }),
              ],
              { stopReason: "toolUse" },
            );
          }
          if (last?.role === "toolResult" && last.toolName === "subagent") {
            const remoteId = /Session ID: (remote:[\w-]+:\d+)/.exec(JSON.stringify(last))?.[1];
            if (remoteId)
              return fauxAssistantMessage(
                [fauxToolCall("subagent", { action: "await", sessionId: remoteId })],
                { stopReason: "toolUse" },
              );
          }
          if (
            last?.role === "user" &&
            JSON.stringify(last).includes("Remote final despite missing attachment")
          ) {
            expect(JSON.stringify(last)).toContain("Remote attachment import failed");
            expect(JSON.stringify(last)).toContain(`Remote file HTTP ${status}`);
            receivedImportFailure = true;
          }
          return fauxAssistantMessage([fauxText("Coordinator finished")]);
        }),
      );
      await (
        await local.runtime.main.submit({ type: "input", content: "Start a coordinator" }, context)
      ).wait(context);
      await eventually(async () => {
        const workers = await local.runtime.orchestration.listRunning();
        for (const worker of workers) {
          const conversation = await local.runtime.conversation(worker.sessionId);
          if (
            JSON.stringify((await conversation.context(context)).messages).includes(
              "Awaiting subagent",
            )
          )
            return true;
        }
        return false;
      }, "coordinator awaiting remote");
      await writeFile(join(remote.work, "release"), "release");
      await eventually(
        async () => (await local.runtime.orchestration.listRunning()).length === 0,
        "coordinator delivery settling despite file failure",
      );
      await eventually(
        async () => local.runtime.remotes.list()[0]?.status === "completed",
        "terminal remote status",
      );
      const id = local.runtime.remotes.list()[0]!.sessionId;
      await eventually(
        async () =>
          JSON.stringify(local.runtime.remotes.messages(id)).includes(
            "Remote final despite missing attachment",
          ),
        "terminal history replay",
      );
      const history = JSON.stringify(local.runtime.remotes.messages(id));
      expect(history).toContain(`Remote file HTTP ${status}`);
      expect(filesIn(local.runtime.remotes.messages(id))).toEqual([]);
      // Re-reading terminal assignment receipts retries transient errors, not 404s.
      const requestsBefore = remote.fileRequests.length;
      const mirror = local.runtime.remotes as unknown as {
        importValue(node: string, value: unknown): Promise<unknown>;
      };
      const source = JSON.parse(
        JSON.stringify((await remote.runtime.state(id.split(":")[2]!)).messages),
      );
      await mirror.importValue(remote.id, source);
      await mirror.importValue(remote.id, source);
      expect(remote.fileRequests.length - requestsBefore).toBe(status === 404 ? 0 : 2);
      if (status !== 404) {
        remote.setFileStatus(200);
        const recovered = await mirror.importValue(remote.id, source);
        expect(filesIn(recovered).some((file) => file.name === "origin.txt")).toBe(true);
        expect(JSON.stringify(recovered)).not.toContain("importErrors");
        const recoveredRequests = remote.fileRequests.length;
        await mirror.importValue(remote.id, source);
        expect(remote.fileRequests).toHaveLength(recoveredRequests);
      }
      expect(await transcript(local.runtime)).toContain("Coordinator finished");
      expect(receivedImportFailure).toBe(true);
    } finally {
      if (b) await writeFile(join(b.work, "release"), "release");
      await a?.close();
      await b?.close();
      await rm(directory, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  },
  45_000,
);

test("node grants cannot access owner routes, revoke immediately, and reciprocal discovery never exports mirrors", async () => {
  vi.stubEnv("PI_OFFLINE", "1");
  const directory = await mkdtemp(join(tmpdir(), "batty-remote-boundary-"));
  let a: Awaited<ReturnType<typeof openInstance>> | undefined;
  let b: Awaited<ReturnType<typeof openInstance>> | undefined;
  try {
    a = await openInstance(directory, "a");
    b = await openInstance(directory, "b");
    const local = a;
    const remote = b;
    await connect(a, b);
    const grant = { token: a.runtime.remotes.connection(b.id).token };
    const listing = await b.app.inject({ url: "/api/remotes", headers: b.owner });
    expect(listing.statusCode).toBe(200);
    expect(listing.json()).toMatchObject({
      ...b.runtime.remotes.access.identity(),
      grants: [],
      connections: [
        {
          id: local.id,
          label: a.runtime.remotes.access.identity().name,
          url: a.url,
          instanceId: local.id,
          transport: "reverse",
          status: { state: "connected" },
        },
      ],
    });
    expect(listing.body).not.toContain("token");
    expect(listing.body).not.toContain("Hash");
    const auth = { authorization: `Bearer ${grant.token}` };
    expect((await b.app.inject({ url: "/api/node/identity" })).statusCode).toBe(401);
    expect(
      (
        await b.app.inject({
          url: "/api/node/identity",
          headers: { authorization: "Bearer wrong" },
        })
      ).statusCode,
    ).toBe(401);
    expect((await b.app.inject({ url: "/api/node/identity", headers: auth })).statusCode).toBe(200);
    expect((await b.app.inject({ url: "/api/node/workspaces" })).statusCode).toBe(401);
    await b.runtime.main.configure({ model: { provider: "faux", modelId: "selected-b" } }, context);
    const nodes = await a.runtime.remotes.workspaces(remote.id);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      nodeId: remote.id,
      defaultModel: "faux/selected-b",
      workspaces: [expect.objectContaining({ id: "work", isAssistant: true })],
    });
    expect(nodes[0]!.models).toEqual(await b.runtime.listModels());
    expect(nodes[0]!.models).toContainEqual(
      expect.objectContaining({ id: "faux/model-b", thinkingLevels: expect.any(Array) }),
    );
    await b.runtime.main.configure({ model: { provider: "faux", modelId: "model-b" } }, context);
    expect((await b.app.inject({ url: "/api/remotes", headers: auth })).statusCode).toBe(401);
    expect((await b.app.inject({ url: "/api/node/identity", headers: b.owner })).statusCode).toBe(
      401,
    );
    b.faux.setResponses([fauxAssistantMessage([fauxText("Remote discovery evidence")])]);
    const started = await b.app.inject({
      method: "POST",
      url: "/api/node/commands",
      headers: auth,
      payload: {
        requestId: "discover-start",
        command: { action: "run", workspaceId: "work", prompt: "discovery" },
      },
    });
    expect(started.statusCode).toBe(200);
    await eventually(async () => a!.runtime.remotes.list().length === 1, "A importing B worker");
    const discovery = await a.app.inject({
      method: "POST",
      url: "/api/node/commands",
      headers: { authorization: `Bearer ${b.runtime.remotes.connection(local.id).token}` },
      payload: { requestId: "list-from-b", command: { action: "list" } },
    });
    expect(discovery.statusCode).toBe(200);
    const listed = JSON.parse(discovery.json().output[0].text);
    expect(listed.workers).toEqual([]);
    expect(b.runtime.remotes.list()).toEqual([]);
    const selfInvitation = await b.app.inject({
      method: "POST",
      url: "/api/remotes",
      headers: b.owner,
      payload: { action: "token-generate" },
    });
    const self = await b.app.inject({
      method: "POST",
      url: "/api/remotes",
      headers: b.owner,
      payload: {
        action: "connection-add",
        url: b.url,
        token: selfInvitation.json().token,
      },
    });
    expect(self.statusCode).toBe(500);
    expect(self.body).toContain("Pairing failed");
    const revoked = await b.app.inject({
      method: "POST",
      url: "/api/remotes",
      headers: b.owner,
      payload: { action: "token-revoke", id: selfInvitation.json().id },
    });
    expect(revoked.statusCode).toBe(200);
    expect((await b.app.inject({ url: "/api/remotes", headers: b.owner })).json().grants).toEqual(
      [],
    );
    const removed = await a.app.inject({
      method: "POST",
      url: "/api/remotes",
      headers: a.owner,
      payload: { action: "connection-remove", id: remote.id },
    });
    expect(removed.statusCode).toBe(200);
    expect(
      (await a.app.inject({ url: "/api/remotes", headers: a.owner })).json().connections,
    ).toEqual([]);
    expect(a.runtime.remotes.access.getConnection(remote.id)).toBeUndefined();
    expect(b.runtime.remotes.access.getConnection(local.id)).toBeUndefined();
    expect((await b.app.inject({ url: "/api/node/identity", headers: auth })).statusCode).toBe(401);
    expect(
      (
        await b.app.inject({
          method: "POST",
          url: "/api/node/commands",
          headers: auth,
          payload: { requestId: "after-revoke", command: { action: "list" } },
        })
      ).statusCode,
    ).toBe(401);
  } finally {
    await Promise.all([a?.close(), b?.close()]);
    await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
}, 30_000);

test("a local assigned worker awaits its remote child without completing its original parent assignment early", async () => {
  vi.stubEnv("PI_OFFLINE", "1");
  const directory = await mkdtemp(join(tmpdir(), "batty-remote-nested-await-"));
  let a: Awaited<ReturnType<typeof openInstance>> | undefined;
  let b: Awaited<ReturnType<typeof openInstance>> | undefined;
  try {
    a = await openInstance(directory, "a");
    b = await openInstance(directory, "b");
    const local = a;
    const remote = b;
    await connect(local, remote);
    remote.faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("bash", {
            command:
              "printf ready > entered; for i in $(seq 1 400); do test -f release && exit 0; sleep 0.05; done; exit 1",
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("B nested child finished")]),
    ]);
    let bridgeId: string | undefined;
    let remoteId: string | undefined;
    let continued = false;
    local.faux.setResponses(
      Array.from({ length: 30 }, () => (request) => {
        const last = request.messages.findLast((message) => message.role !== "system")!;
        const content = JSON.stringify(last);
        if (last.role === "toolResult" && last.toolName === "subagent") {
          const id = /Session ID: (remote:[\w-]+:\d+|\d+)/.exec(content)?.[1];
          if (id?.startsWith("remote:")) {
            remoteId = id;
            return fauxAssistantMessage(
              [fauxToolCall("subagent", { action: "await", sessionId: id })],
              { stopReason: "toolUse" },
            );
          }
          if (id) bridgeId = id;
          return fauxAssistantMessage([fauxText("A main waiting for local bridge")]);
        }
        if (last.role === "user" && content.includes("B nested child finished")) {
          continued = true;
          return fauxAssistantMessage([fauxText("Local bridge completed after B")]);
        }
        if (last.role === "user" && content.includes("[subagent"))
          return fauxAssistantMessage([fauxText("A main received local bridge result")]);
        if (last.role === "user" && content.includes("local bridge child"))
          return fauxAssistantMessage(
            [
              fauxToolCall("subagent", {
                action: "run",
                nodeId: remote.id,
                workspaceId: "work",
                prompt: "B nested task",
              }),
            ],
            { stopReason: "toolUse" },
          );
        return fauxAssistantMessage(
          [
            fauxToolCall("subagent", {
              action: "run",
              workspaceId: "work",
              prompt: "local bridge child",
            }),
          ],
          { stopReason: "toolUse" },
        );
      }),
    );
    await (
      await local.runtime.main.submit(
        { type: "input", content: "Start nested integration" },
        context,
      )
    ).wait(context);
    await eventually(
      async () => Boolean(bridgeId && remoteId),
      "local bridge awaiting remote child",
    );
    await eventually(async () => {
      const bridge = await local.runtime.orchestration.metadata(
        (await local.runtime.conversation(bridgeId!)).id,
      );
      return Object.keys(bridge?.completion?.waits ?? {}).some((key) =>
        key.startsWith(`remote:${remote.id}:`),
      );
    }, "remote wait recorded on local assignment completion");
    expect(continued).toBe(false);
    expect(await transcript(local.runtime)).not.toContain("Local bridge completed after B");
    const active = await local.runtime.orchestration.listRunning();
    expect(active.some((item) => item.sessionId === bridgeId)).toBe(true);
    expect((await remote.runtime.main.context(context)).messages).toHaveLength(0);
    await writeFile(join(remote.work, "release"), "release");
    await eventually(
      async () => (await transcript(local.runtime)).includes("Local bridge completed after B"),
      "local original assignment finishing after remote result",
    );
    expect(continued).toBe(true);
    await eventually(
      async () => (await local.runtime.orchestration.listRunning()).length === 0,
      "local bridge completion",
    );
    expect((await remote.runtime.main.context(context)).messages).toHaveLength(0);
    const bridge = await local.runtime.conversation(bridgeId!);
    const state = await local.runtime.state(String(bridge.id));
    expect(JSON.stringify(state.messages)).toContain("B nested child finished");
    expect(JSON.stringify(state.messages)).toContain("Local bridge completed after B");
    const parentEntries = JSON.parse(await transcript(local.runtime)) as Array<{
      model?: Array<{ role: string; content: unknown }>;
    }>;
    expect(
      parentEntries
        .flatMap((entry) => entry.model ?? [])
        .filter(
          (message) =>
            message.role === "user" &&
            JSON.stringify(message.content).includes("Local bridge completed after B"),
        ),
    ).toHaveLength(1);
  } finally {
    if (b) await writeFile(join(b.work, "release"), "release");
    await Promise.all([a?.close(), b?.close()]);
    await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
}, 30_000);

test("catalog skips historical worker streams and retires active streams until the worker resumes", async () => {
  vi.stubEnv("PI_OFFLINE", "1");
  const directory = await mkdtemp(join(tmpdir(), "batty-remote-stream-lifecycle-"));
  let a: Awaited<ReturnType<typeof openInstance>> | undefined;
  let b: Awaited<ReturnType<typeof openInstance>> | undefined;
  try {
    a = await openInstance(directory, "a");
    b = await openInstance(directory, "b");
    const local = a;
    const remote = b;
    remote.faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("subagent", {
            action: "run",
            workspaceId: "work",
            prompt: "Historical local worker",
          }),
        ],
        { stopReason: "toolUse" },
      ),
      ...Array.from({ length: 10 }, () =>
        fauxAssistantMessage([fauxText("Historical worker completed")]),
      ),
    ]);
    await (
      await remote.runtime.main.submit(
        { type: "input", content: "Create a native historical worker" },
        context,
      )
    ).wait(context);
    await eventually(
      async () => (await remote.runtime.orchestration.listRunning()).length === 0,
      "native historical worker finishing",
    );
    const discovered = await remote.runtime.orchestration.nodeCommand(
      "fixture",
      "historical-list",
      { action: "list" },
    );
    const historical = JSON.parse((discovered.output as Array<{ text: string }>)[0]!.text)
      .workers as Array<{ sessionId: string; status: string }>;
    expect(historical).toHaveLength(1);
    expect(historical[0]!.status).toBe("completed");
    const historicalId = historical[0]!.sessionId;

    await connect(local, remote);
    await eventually(
      async () =>
        local.runtime.remotes
          .list()
          .some((worker) => worker.sessionId === `remote:${remote.id}:${historicalId}`),
      "historical worker discovery",
    );
    expect(remote.sessionStreams).toHaveLength(0);
    const streamsFor = (id: string) =>
      remote.sessionStreams.filter(
        (stream) => new URL(stream.url, remote.url).pathname === `/api/node/sessions/${id}/events`,
      );
    remote.faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("bash", {
            command:
              "printf ready > entered; for i in $(seq 1 400); do test -f release && exit 0; sleep 0.05; done; exit 1",
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("Active stream first terminal result")]),
    ]);
    local.faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("subagent", {
            action: "run",
            nodeId: remote.id,
            workspaceId: "work",
            prompt: "Active streaming worker",
          }),
        ],
        { stopReason: "toolUse" },
      ),
      ...Array.from({ length: 10 }, () =>
        fauxAssistantMessage([fauxText("Observed remote lifecycle")]),
      ),
    ]);
    await (
      await local.runtime.main.submit(
        { type: "input", content: "Start active remote worker" },
        context,
      )
    ).wait(context);
    await eventually(
      async () => remote.sessionStreams.some((stream) => !stream.closed),
      "active worker event stream opening",
    );
    const active = local.runtime.remotes
      .list()
      .find((worker) => worker.sessionId !== `remote:${remote.id}:${historicalId}`)!;
    expect(active).toBeDefined();
    const sessionId = active.sessionId.split(":")[2]!;
    expect(streamsFor(sessionId)).toHaveLength(1);
    expect(streamsFor(sessionId)[0]!.closed).toBe(false);
    await writeFile(join(remote.work, "release"), "release");
    // Opening the remote HTTP stream precedes importing its first snapshot locally.
    // Poll through the expected 404 until the terminal history has been mirrored.
    await expect
      .poll(() => JSON.stringify(local.runtime.remotes.messages(active.sessionId)), {
        timeout: 15_000,
      })
      .toContain("Active stream first terminal result");
    await eventually(
      async () => streamsFor(sessionId)[0]!.closed,
      "terminal session stream retiring",
    );
    expect((await local.runtime.state(active.sessionId)).isStreaming).toBe(false);
    expect(
      local.runtime.remotes.list().find((worker) => worker.sessionId === active.sessionId)?.status,
    ).toBe("completed");

    remote.faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("bash", {
            command:
              "printf ready > entered-resume; for i in $(seq 1 400); do test -f release-resume && exit 0; sleep 0.05; done; exit 1",
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("Resumed stream second terminal result")]),
    ]);
    local.faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("subagent", {
            action: "resume",
            sessionId: active.sessionId,
            prompt: "Resume remote streaming worker",
          }),
        ],
        { stopReason: "toolUse" },
      ),
      ...Array.from({ length: 10 }, () =>
        fauxAssistantMessage([fauxText("Observed resumed remote lifecycle")]),
      ),
    ]);
    await (
      await local.runtime.main.submit(
        { type: "input", content: "Resume the completed remote worker" },
        context,
      )
    ).wait(context);
    await eventually(
      async () => streamsFor(sessionId).length === 2,
      "resumed worker event stream reopening",
    );
    const resumedStream = streamsFor(sessionId)[1]!;
    expect(resumedStream.closed).toBe(false);
    expect(new URL(resumedStream.url, remote.url).searchParams.get("after")).not.toBe("0");
    await eventually(
      async () => (await local.runtime.state(active.sessionId)).isStreaming,
      "resumed worker active projection",
    );
    await writeFile(join(remote.work, "release-resume"), "release");
    await eventually(
      async () =>
        JSON.stringify(local.runtime.remotes.messages(active.sessionId)).includes(
          "Resumed stream second terminal result",
        ),
      "resumed terminal history mirrored",
    );
    await eventually(async () => resumedStream.closed, "resumed terminal stream retiring");
    expect(streamsFor(sessionId)).toHaveLength(2);
    expect(streamsFor(historicalId)).toHaveLength(0);
    expect(JSON.stringify(local.runtime.remotes.messages(active.sessionId))).toContain(
      "Active stream first terminal result",
    );
  } finally {
    if (b) {
      await writeFile(join(b.work, "release"), "release");
      await writeFile(join(b.work, "release-resume"), "release");
    }
    await Promise.all([a?.close(), b?.close()]);
    await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
}, 30_000);

test("terminal metadata cannot retire a stream before its committed result cursor is mirrored", async () => {
  vi.stubEnv("PI_OFFLINE", "1");
  const directory = await mkdtemp(join(tmpdir(), "batty-remote-terminal-cursor-"));
  let a: Awaited<ReturnType<typeof openInstance>> | undefined;
  let b: Awaited<ReturnType<typeof openInstance>> | undefined;
  let restoreState: (() => void) | undefined;
  const heldReads = Promise.withResolvers<void>();
  try {
    a = await openInstance(directory, "a");
    b = await openInstance(directory, "b");
    const local = a;
    const remote = b;
    await connect(local, remote);
    remote.faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("bash", {
            command:
              "printf ready > entered; for i in $(seq 1 400); do test -f release && exit 0; sleep 0.05; done; exit 1",
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("Cursor race final result")]),
    ]);
    local.faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("subagent", {
            action: "run",
            nodeId: remote.id,
            workspaceId: "work",
            prompt: "Exercise terminal cursor race",
          }),
        ],
        { stopReason: "toolUse" },
      ),
      ...Array.from({ length: 10 }, () =>
        fauxAssistantMessage([fauxText("Observed cursor race worker")]),
      ),
    ]);
    let targetSession: string | undefined;
    let injected = false;
    let staleCursor: string | undefined;
    let resultCursor: number | undefined;
    let catchupReadEntered = false;
    const nativeState = remote.runtime.state.bind(remote.runtime);
    const stateSpy = vi.spyOn(remote.runtime, "state").mockImplementation(async (...args) => {
      const state = await nativeState(...args);
      if (args[0] !== targetSession || !args[2]) return state;
      const final = state.messages.find(
        (message) => message.role === "custom" && message.customType === "batty.remote-result",
      );
      if (!final || state.isStreaming || state.canStopSubagent) return state;
      if (!injected) {
        injected = true;
        resultCursor = Number(final.id.split(":")[0]);
        const earlier = state.messages.filter(
          (message) => Number(message.id.split(":")[0]) < resultCursor!,
        );
        staleCursor = String(
          Math.max(
            Number(args[3] ?? 0),
            ...earlier.map((message) => Number(message.id.split(":")[0])),
          ),
        );
        // Simulate live metadata being read after completion, but the history boundary before it.
        return {
          ...state,
          messages: earlier,
          historyCursor: staleCursor,
          hasMoreRecentMessages: false,
          isStreaming: false,
          canStopSubagent: false,
        };
      }
      // Keep the catch-up observable, rather than letting a concurrent flush hide the split snapshot.
      catchupReadEntered = true;
      await heldReads.promise;
      return state;
    });
    restoreState = () => stateSpy.mockRestore();
    await (
      await local.runtime.main.submit(
        { type: "input", content: "Start terminal cursor race" },
        context,
      )
    ).wait(context);
    await eventually(
      async () => local.runtime.remotes.list().length === 1 && remote.sessionStreams.length === 1,
      "race worker stream opening",
    );
    const mirroredId = local.runtime.remotes.list()[0]!.sessionId;
    targetSession = mirroredId.split(":")[2]!;
    await writeFile(join(remote.work, "release"), "release");
    await eventually(async () => {
      if (!injected) return false;
      const state = await local.runtime.state(mirroredId);
      const summary = local.runtime.remotes.list()[0]!;
      return (
        !state.isStreaming &&
        !state.canStopSubagent &&
        state.historyCursor === staleCursor &&
        Number(summary.terminalCursor) >= resultCursor!
      );
    }, "stale terminal snapshot mirrored below the authoritative catalog cursor");
    expect(Number(staleCursor)).toBeLessThan(resultCursor!);
    expect(await transcript(local.runtime)).not.toContain("Cursor race final result");
    const worker = await remote.runtime.conversation(targetSession);
    await worker.commit(
      (tx) => tx.appendEntry(worker.id, { kind: "test.terminal-cursor-refresh" }),
      context,
    );
    await eventually(
      async () => catchupReadEntered,
      "same stream requesting the missing journal tail",
    );
    expect(remote.sessionStreams).toHaveLength(1);
    expect(remote.sessionStreams[0]!.closed).toBe(false);
    heldReads.resolve();
    await eventually(
      async () => (await transcript(local.runtime)).includes("Cursor race final result"),
      "committed final result delivered after cursor catch-up",
    );
    await eventually(
      async () => remote.sessionStreams[0]!.closed,
      "stream retiring only after final cursor catch-up",
    );
    expect((await transcript(local.runtime)).match(/Cursor race final result/g)).toHaveLength(1);
    expect(JSON.stringify(local.runtime.remotes.messages(mirroredId))).toContain(
      "batty.remote-result",
    );
    expect(remote.sessionStreams).toHaveLength(1);
  } finally {
    heldReads.resolve();
    restoreState?.();
    if (b) await writeFile(join(b.work, "release"), "release");
    await Promise.all([a?.close(), b?.close()]);
    await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
}, 30_000);

test("multipart node commands authenticate, reject corrupt/incomplete transfers before admission, and replay without duplicate work", async () => {
  vi.stubEnv("PI_OFFLINE", "1");
  const directory = await mkdtemp(join(tmpdir(), "batty-node-input-replay-"));
  const remote = await openInstance(directory, "receiver");
  const sender = await openInstance(directory, "sender");
  try {
    await connect(sender, remote);
    const grant = sender.runtime.remotes.connection(remote.id);
    let calls = 0;
    remote.faux.setResponses(
      Array.from({ length: 10 }, () => () => {
        calls++;
        return fauxAssistantMessage([fauxText("input processed")]);
      }),
    );
    const source = join(directory, "evidence.txt");
    const bytes = Buffer.from("durable input bytes");
    await writeFile(source, bytes);
    const [file] = await storeSentFiles({
      rootDir: join(directory, "sender-files"),
      workspaceId: "sender",
      sessionId: "1",
      toolCallId: "input",
      cwd: directory,
      paths: [source],
    });
    const files = [
      {
        name: file!.name,
        size: file!.size,
        mimeType: file!.mimeType,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        file: file!,
      },
    ];
    const command = { action: "run", prompt: "process transferred input", workspaceId: "work" };
    const send = async (body: FormData, token = grant.token) =>
      fetch(new URL("api/node/commands", remote.url), {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body,
      });
    const denied = await send(await workerCommandBody(command, "denied", files), "invalid");
    expect(denied.status).toBe(401);
    await denied.body?.cancel();
    const corrupt = await send(
      await workerCommandBody(command, "attempt", [{ ...files[0]!, sha256: "0".repeat(64) }]),
    );
    expect(corrupt.status).toBe(400);
    expect(await corrupt.text()).toContain("integrity check failed");
    const missingBody = await workerCommandBody(command, "missing", files);
    missingBody.delete("file-0");
    const missing = await send(missingBody);
    expect(missing.status).toBe(400);
    expect(await missing.text()).toContain("Missing worker file parts");
    expect(await remote.runtime.orchestration.listRunning()).toHaveLength(0);
    expect(calls).toBe(0);
    const first = await send(await workerCommandBody(command, "attempt", files));
    expect(first.status).toBe(200);
    const receipt = await first.json();
    await eventually(
      async () => (await remote.runtime.orchestration.listRunning()).length === 0,
      "single imported assignment",
    );
    const duplicate = await send(await workerCommandBody(command, "attempt", files));
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual(receipt);
    expect(calls).toBe(1);
    const changed = await send(
      await workerCommandBody({ ...command, prompt: "different assignment" }, "attempt", files),
    );
    expect(changed.ok).toBe(false);
    expect(await changed.text()).toContain("reused with different arguments");
    const jsonPath = await remote.app.inject({
      method: "POST",
      url: "/api/node/commands",
      headers: { authorization: `Bearer ${grant.token}` },
      payload: {
        requestId: "path-injection",
        command: { ...command, files: [{ path: join(remote.work, "origin.txt") }] },
      },
    });
    expect(jsonPath.statusCode).not.toBe(200);
    expect(calls).toBe(1);
    await remote.runtime.remotes.access.revoke(grant.grantId!);
    const revoked = await send(await workerCommandBody(command, "revoked", files));
    expect(revoked.status).toBe(401);
    await revoked.body?.cancel();
  } finally {
    await sender.close();
    await remote.close();
    await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
}, 30_000);

test.each(["http", "reverse"] as const)(
  "%s run/queue/steer/resume carry selected paths and received refs, images, immutable queued bytes and locally mirrored input attachments",
  async (transport) => {
    vi.stubEnv("PI_OFFLINE", "1");
    const directory = await mkdtemp(join(tmpdir(), "batty-input-files-"));
    let a: Awaited<ReturnType<typeof openInstance>> | undefined;
    let b: Awaited<ReturnType<typeof openInstance>> | undefined;
    try {
      a = await openInstance(directory, "a");
      b = await openInstance(directory, "b");
      const local = a;
      const remote = b;
      if (transport === "reverse") await connectReverse(local, remote);
      else await connect(local, remote);
      const source = join(local.work, "evidence.txt");
      const image = join(local.work, "drawing.png");
      const binary = join(local.work, "large.bin");
      const binaryBytes = Buffer.allocUnsafe(2 * 1024 * 1024 + 137);
      for (let index = 0; index < binaryBytes.length; index++) binaryBytes[index] = index % 251;
      const binaryHash = createHash("sha256").update(binaryBytes).digest("hex");
      await writeFile(binary, binaryBytes);
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC",
        "base64",
      );
      await writeFile(source, "original sender bytes");
      await writeFile(image, png);
      let next: Record<string, import("@earendil-works/chord").JsonValue> = {};
      let id: string | undefined;
      let parentSequence = 0;
      let pendingParent = "";
      local.faux.setResponses(
        Array.from({ length: 80 }, () => (request) => {
          const last = request.messages.findLast((message) => message.role !== "system")!;
          const text = JSON.stringify(last.content);
          if (last.role === "user" && text.includes("seed-parent-ref"))
            return fauxAssistantMessage([fauxToolCall("attach_files", { paths: [source] })], {
              stopReason: "toolUse",
            });
          if (
            pendingParent &&
            request.messages.some(
              (message) =>
                message.role === "user" && JSON.stringify(message.content).includes(pendingParent),
            )
          ) {
            pendingParent = "";
            return fauxAssistantMessage([fauxToolCall("subagent", next)], {
              stopReason: "toolUse",
            });
          }
          if (last.role === "toolResult" && last.toolName === "subagent")
            id ??= /Session ID: (remote:[\w-]+:\d+)/.exec(text)?.[1];
          return fauxAssistantMessage([fauxText("parent acknowledged")]);
        }),
      );
      const received: Array<{
        phase: string;
        bytes: string;
        image: boolean;
        path: string;
        binaryHash: string;
      }> = [];
      remote.faux.setResponses(
        Array.from({ length: 40 }, () => (request) => {
          const last = request.messages.findLast((message) => message.role !== "system")!;
          if (last.role === "user") {
            const blocks =
              typeof last.content === "string"
                ? [{ type: "text" as const, text: last.content }]
                : last.content;
            const text = blocks
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("\n");
            const phase = /remote-phase-(run|queue|steer|resume)/.exec(text)?.[1];
            if (phase) {
              const path = /path="([^"]+)"/.exec(text)![1]!;
              expect(path).toContain(remote.config.sentFilesDir);
              expect(text).not.toContain(source);
              expect(text).not.toContain("<batty-runtime-notice>");
              received.push({
                phase,
                path,
                bytes: readFileSync(path, "utf8"),
                binaryHash: createHash("sha256")
                  .update(
                    readFileSync(
                      [...text.matchAll(/path="([^"]+)"/g)]
                        .map((match) => match[1]!)
                        .find((value) => value.endsWith("large.bin"))!,
                    ),
                  )
                  .digest("hex"),
                image: blocks.some(
                  (block) => block.type === "image" && block.data === png.toString("base64"),
                ),
              });
              if (phase === "run")
                return fauxAssistantMessage(
                  [
                    fauxToolCall("bash", {
                      command:
                        "printf ready > input-entered; for i in $(seq 1 400); do test -f input-release && exit 0; sleep 0.05; done; exit 1",
                    }),
                  ],
                  { stopReason: "toolUse" },
                );
            }
          }
          return fauxAssistantMessage([fauxText("remote file assignment complete")]);
        }),
      );
      const parent = async (content: string) => {
        if (content === "parent-command")
          content = pendingParent = `parent-command-${++parentSequence}`;
        await (await local.runtime.main.submit({ type: "input", content }, context)).wait(context);
      };
      await parent("seed-parent-ref");
      const seeded = (await local.runtime.main.context(context)).messages.findLast(
        (message) => message.role === "toolResult" && message.toolName === "attach_files",
      )!;
      const seedFiles = filesIn(seeded);
      expect(seedFiles).toHaveLength(1);
      const ref = artifactRefs({ sentFiles: seedFiles })[0]!.ref;
      const send = async (action: string, phase: string, useRef = false) => {
        next = {
          action,
          ...(id ? { sessionId: id } : { nodeId: remote.id, workspaceId: "work" }),
          prompt: `remote-phase-${phase}`,
          files: [useRef ? { ref } : { path: source }, { path: image }, { path: binary }],
        };
        await parent("parent-command");
        const result = (await local.runtime.main.context(context)).messages.findLast(
          (message) => message.role === "toolResult" && message.toolName === "subagent",
        );
        expect(result, JSON.stringify(result)).toMatchObject({ isError: false });
      };
      await send("run", "run", true);
      await eventually(async () => {
        try {
          await readFile(join(remote.work, "input-entered"));
          return true;
        } catch {
          return false;
        }
      }, "remote input hold");
      await send("queue", "queue");
      await writeFile(source, "changed after queue");
      await send("steer", "steer");
      await writeFile(source, "changed after steer");
      await writeFile(join(remote.work, "input-release"), "release");
      await eventually(
        async () => (await remote.runtime.orchestration.listRunning()).length === 0,
        "queued remote file assignments",
      );
      expect(received.map(({ phase, bytes, image }) => ({ phase, bytes, image }))).toEqual([
        { phase: "run", bytes: "original sender bytes", image: true },
        { phase: "steer", bytes: "changed after queue", image: true },
        { phase: "queue", bytes: "original sender bytes", image: true },
      ]);
      await send("resume", "resume");
      await eventually(
        async () => (await remote.runtime.orchestration.listRunning()).length === 0,
        "resumed remote input assignment",
      );
      expect(received.every((entry) => entry.binaryHash === binaryHash)).toBe(true);
      expect(received.at(-1)).toMatchObject({
        phase: "resume",
        bytes: "changed after steer",
        image: true,
      });
      await eventually(async () => {
        try {
          return filesIn(local.runtime.remotes.state(id!)).length >= 8;
        } catch {
          return false;
        }
      }, "locally imported input attachments");
      const mirrored = filesIn(local.runtime.remotes.state(id!));
      expect(mirrored.some((file) => file.name === "large.bin")).toBe(true);
      expect(mirrored.map((file) => new URL(file.downloadUrl, local.url).pathname)).toEqual(
        expect.arrayContaining([expect.stringContaining(`/api/sent-files/remote-${remote.id}/`)]),
      );
      expect(mirrored.map((file) => new URL(file.downloadUrl, local.url).pathname)).toEqual(
        mirrored.map(() => expect.stringContaining(`/api/sent-files/remote-${remote.id}/`)),
      );
      for (const file of mirrored) {
        const match = /\/api\/sent-files\/([^/]+)\/([^/]+)\/([^/]+)\/([^/?]+)/.exec(
          file.downloadUrl,
        )!;
        const resolved = await resolveSentFile({
          rootDir: local.config.sentFilesDir,
          workspaceId: match[1]!,
          sessionId: match[2]!,
          toolCallId: match[3]!,
          fileId: match[4]!,
        });
        const bytes = await readFile(resolved.storedPath);
        expect(bytes.length).toBeGreaterThan(0);
        if (file.name === "large.bin") expect(bytes).toEqual(binaryBytes);
      }
    } finally {
      if (b) await writeFile(join(b.work, "input-release"), "release");
      await a?.close();
      await b?.close();
      await rm(directory, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  },
  30_000,
);
