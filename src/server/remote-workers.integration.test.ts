import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
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
import { authenticateNode, registerRemoteRoutes } from "./routes/remotes";
import { resolveSentFile } from "./send-files";
import type { SentFileDescriptor } from "../shared/types";

async function eventually(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function openInstance(directory: string, name: string) {
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
  const sessionStreams: Array<{ url: string; closed: boolean }> = [];
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
  const url = `${await app.listen({ host: "127.0.0.1", port: 0 })}/`;
  let closed = false;
  return {
    app,
    runtime,
    faux,
    config,
    work,
    url,
    sessionStreams,
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
  id: string,
) {
  const issued = await to.app.inject({
    method: "POST",
    url: "/api/remotes",
    headers: to.owner,
    payload: { action: "grant-add", label: `Grant for ${id}` },
  });
  expect(issued.statusCode).toBe(200);
  const grant = issued.json<{ id: string; token: string }>();
  const connected = await from.app.inject({
    method: "POST",
    url: "/api/remotes",
    headers: from.owner,
    payload: { action: "connection-add", id, label: id, url: to.url, token: grant.token },
  });
  expect(connected.statusCode, connected.body).toBe(200);
  return grant;
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

test("two runtimes execute remote native tools, deliver progress to the initiating parent, and retain local history/files offline", async () => {
  vi.stubEnv("PI_OFFLINE", "1");
  const directory = await mkdtemp(join(tmpdir(), "batty-two-runtimes-"));
  let a: Awaited<ReturnType<typeof openInstance>> | undefined;
  let b: Awaited<ReturnType<typeof openInstance>> | undefined;
  try {
    a = await openInstance(directory, "a");
    b = await openInstance(directory, "b");
    const local = a;
    const remote = b;
    await connect(local, remote, "b");
    let bModelCalls = 0;
    remote.faux.setResponses([
      (request) => {
        bModelCalls++;
        expect(JSON.stringify(request.messages)).toContain("Unique instance b workspace guidance.");
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
        return fauxAssistantMessage([fauxToolCall("attach_files", { paths: ["origin.txt"] })], {
          stopReason: "toolUse",
        });
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
                nodeId: "b",
                workspaceId: "work",
                prompt: "Read origin.txt, attach evidence, report progress and finish",
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        const last = request.messages.findLast((message) => message.role !== "system");
        if (last?.role === "toolResult" && last.toolName === "subagent") {
          const remoteId = /Started[^]*?Session ID: (remote:b:\d+)/.exec(JSON.stringify(last))?.[1];
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
    expect(id).toMatch(/^remote:b:\d+$/);
    await eventually(
      async () =>
        local.runtime.remotes.tasks(local.runtime.main.id).some((row) => row.sessionId === id),
      "remote Tasks row",
    );
    const state = await local.runtime.state(id);
    expect(state.cwd).toBe(remote.work);
    expect(state.model).toBe("faux/model-b");
    expect(state.isStreaming).toBe(true);
    const worker = await remote.runtime.conversation(id.split(":")[2]!);
    expect((await worker.agent(context)).cwd).toBe(remote.work);
    expect((await worker.agent(context)).model).toMatchObject({ modelId: "model-b" });

    // Finish while disconnected, then recover the missed terminal event through replay.
    local.runtime.remotes.disconnect("b");
    await writeFile(join(remote.work, "release"), "release");
    await eventually(
      async () => (await remote.runtime.orchestration.listRunning()).length === 0,
      "B finishing during stream disconnect",
    );
    local.runtime.remotes.connect("b");
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
    const history = local.runtime.remotes.messages(id);
    expect(JSON.stringify(history)).toContain("B final complete");
    const copied = filesIn(history).find((file) => file.name === "origin.txt");
    expect(copied).toBeDefined();
    expect(copied!.downloadUrl).toContain("/api/sent-files/remote-b/");
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
    local.runtime.remotes.disconnect("b");
    expect(await readFile(stored.storedPath, "utf8")).toBe("tools executed on b");
    expect(JSON.stringify(local.runtime.remotes.messages(id))).toContain("B final complete");
    await local.close();
    // Reopen A without reconnecting to B: projections and bytes are local durable state.
    const reopened = await Runtime.open(local.config, { resume: false });
    try {
      reopened.remotes.disconnect("b");
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
}, 45_000);

test("node grants cannot access owner routes, revoke immediately, and reciprocal discovery never exports mirrors", async () => {
  vi.stubEnv("PI_OFFLINE", "1");
  const directory = await mkdtemp(join(tmpdir(), "batty-remote-boundary-"));
  let a: Awaited<ReturnType<typeof openInstance>> | undefined;
  let b: Awaited<ReturnType<typeof openInstance>> | undefined;
  try {
    a = await openInstance(directory, "a");
    b = await openInstance(directory, "b");
    const grant = await connect(a, b, "b");
    await connect(b, a, "a");
    const listing = await b.app.inject({ url: "/api/remotes", headers: b.owner });
    expect(listing.statusCode).toBe(200);
    expect(listing.json()).toEqual({
      instanceId: b.runtime.remotes.access.identity().instanceId,
      grants: [{ id: grant.id, label: "Grant for b" }],
      connections: [
        {
          id: "a",
          label: "a",
          url: a.url,
          instanceId: a.runtime.remotes.access.identity().instanceId,
          grantId: a.runtime.remotes.access.listGrants()[0]!.id,
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
      headers: { authorization: `Bearer ${b.runtime.remotes.connection("a").token}` },
      payload: { requestId: "list-from-b", command: { action: "list" } },
    });
    expect(discovery.statusCode).toBe(200);
    const listed = JSON.parse(discovery.json().output[0].text);
    expect(listed.workers).toEqual([]);
    expect(b.runtime.remotes.list()).toEqual([]);
    const self = await b.app.inject({
      method: "POST",
      url: "/api/remotes",
      headers: b.owner,
      payload: {
        action: "connection-add",
        id: "self",
        label: "self",
        url: b.url,
        token: grant.token,
      },
    });
    expect(self.statusCode).toBe(500);
    expect(self.body).toContain("itself");
    const revoked = await b.app.inject({
      method: "POST",
      url: "/api/remotes",
      headers: b.owner,
      payload: { action: "grant-revoke", id: grant.id },
    });
    expect(revoked.statusCode).toBe(200);
    expect((await b.app.inject({ url: "/api/remotes", headers: b.owner })).json().grants).toEqual(
      [],
    );
    const removed = await a.app.inject({
      method: "POST",
      url: "/api/remotes",
      headers: a.owner,
      payload: { action: "connection-remove", id: "b" },
    });
    expect(removed.statusCode).toBe(200);
    expect(
      (await a.app.inject({ url: "/api/remotes", headers: a.owner })).json().connections,
    ).toEqual([]);
    expect(a.runtime.remotes.access.getConnection("b")).toBeUndefined();
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
    await connect(local, remote, "b");
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
          const id = /Session ID: (remote:b:\d+|\d+)/.exec(content)?.[1];
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
                nodeId: "b",
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
        key.startsWith("remote:b:"),
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

    await connect(local, remote, "b");
    await eventually(
      async () =>
        local.runtime.remotes
          .list()
          .some((worker) => worker.sessionId === `remote:b:${historicalId}`),
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
            nodeId: "b",
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
      .find((worker) => worker.sessionId !== `remote:b:${historicalId}`)!;
    expect(active).toBeDefined();
    const sessionId = active.sessionId.split(":")[2]!;
    expect(streamsFor(sessionId)).toHaveLength(1);
    expect(streamsFor(sessionId)[0]!.closed).toBe(false);
    await writeFile(join(remote.work, "release"), "release");
    await eventually(
      async () =>
        JSON.stringify(local.runtime.remotes.messages(active.sessionId)).includes(
          "Active stream first terminal result",
        ),
      "terminal history mirrored before retirement",
    );
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
    await connect(local, remote, "b");
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
            nodeId: "b",
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
