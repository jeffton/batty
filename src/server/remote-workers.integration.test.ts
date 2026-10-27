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
import { authenticateNode, registerRemoteRoutes } from "./routes/remotes";
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
  const sessionStreams: Array<{ url: string; closed: boolean }> = [];
  app.addHook("onRequest", async (request, reply) => {
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
    fileRequests,
    setFileStatus(status: number) {
      fileStatus = status;
    },
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
    expect(remote.fileRequests.length).toBeGreaterThan(0);
    expect(remote.fileRequests.every((url) => !/%2f/i.test(url))).toBe(true);
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

test.each([404, 408, 429, 503])(
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
      await connect(local, remote, "b");
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
                  nodeId: "b",
                  workspaceId: "work",
                  prompt: "Attach evidence and finish",
                }),
              ],
              { stopReason: "toolUse" },
            );
          }
          if (last?.role === "toolResult" && last.toolName === "subagent") {
            const remoteId = /Session ID: (remote:b:\d+)/.exec(JSON.stringify(last))?.[1];
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
      await mirror.importValue("b", source);
      await mirror.importValue("b", source);
      expect(remote.fileRequests.length - requestsBefore).toBe(status === 404 ? 0 : 2);
      if (status !== 404) {
        remote.setFileStatus(200);
        const recovered = await mirror.importValue("b", source);
        expect(filesIn(recovered).some((file) => file.name === "origin.txt")).toBe(true);
        expect(JSON.stringify(recovered)).not.toContain("importErrors");
        const recoveredRequests = remote.fileRequests.length;
        await mirror.importValue("b", source);
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
    expect((await b.app.inject({ url: "/api/node/workspaces" })).statusCode).toBe(401);
    await b.runtime.main.configure({ model: { provider: "faux", modelId: "selected-b" } }, context);
    const nodes = await a.runtime.remotes.workspaces("b");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      nodeId: "b",
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

test("multipart node commands authenticate, reject corrupt/incomplete transfers before admission, and replay without duplicate work", async () => {
  vi.stubEnv("PI_OFFLINE", "1");
  const directory = await mkdtemp(join(tmpdir(), "batty-node-input-replay-"));
  const remote = await openInstance(directory, "receiver");
  try {
    const grant = await remote.runtime.remotes.access.issue("sender");
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
    await remote.runtime.remotes.access.revoke(grant.id);
    const revoked = await send(await workerCommandBody(command, "revoked", files));
    expect(revoked.status).toBe(401);
    await revoked.body?.cancel();
  } finally {
    await remote.close();
    await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
}, 30_000);

test("remote run/queue/steer/resume carry selected paths and received refs, images, immutable queued bytes and locally mirrored input attachments", async () => {
  vi.stubEnv("PI_OFFLINE", "1");
  const directory = await mkdtemp(join(tmpdir(), "batty-input-files-"));
  let a: Awaited<ReturnType<typeof openInstance>> | undefined;
  let b: Awaited<ReturnType<typeof openInstance>> | undefined;
  try {
    a = await openInstance(directory, "a");
    b = await openInstance(directory, "b");
    const local = a;
    const remote = b;
    await connect(local, remote, "b");
    const source = join(local.work, "evidence.txt");
    const image = join(local.work, "drawing.png");
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
          return fauxAssistantMessage([fauxToolCall("subagent", next)], { stopReason: "toolUse" });
        }
        if (last.role === "toolResult" && last.toolName === "subagent")
          id ??= /Session ID: (remote:b:\d+)/.exec(text)?.[1];
        return fauxAssistantMessage([fauxText("parent acknowledged")]);
      }),
    );
    const received: Array<{ phase: string; bytes: string; image: boolean; path: string }> = [];
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
        ...(id ? { sessionId: id } : { nodeId: "b", workspaceId: "work" }),
        prompt: `remote-phase-${phase}`,
        files: [useRef ? { ref } : { path: source }, { path: image }],
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
    expect(mirrored.every((file) => file.downloadUrl.startsWith("/api/sent-files/remote-b/"))).toBe(
      true,
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
      expect((await readFile(resolved.storedPath)).length).toBeGreaterThan(0);
    }
  } finally {
    if (b) await writeFile(join(b.work, "input-release"), "release");
    await a?.close();
    await b?.close();
    await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
}, 30_000);
