// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import fastify from "fastify";
import { expect, test, vi } from "vite-plus/test";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { loadConfig } from "../config";
import { Runtime, context } from "../runtime";
import { TranscriptImages } from "../transcript-images";
import { registerSessionRoutes } from "./sessions";

test("running subagents expose each worker's current model and effort, not server defaults", async () => {
  const directory = await mkdtemp(join(tmpdir(), "batty-subagent-models-"));
  vi.stubEnv("PI_OFFLINE", "1");
  await mkdir(join(directory, ".batty"));
  await mkdir(join(directory, "work"));
  await writeFile(
    join(directory, ".batty/options.json"),
    JSON.stringify({ workspacesRoots: [directory], webPushSubject: "mailto:test@example.com" }),
  );
  const config = {
    ...(await loadConfig(directory)),
    selfPath: join(directory, "work"),
    defaultProvider: "faux",
    defaultModel: "default",
    defaultThinkingLevel: "off" as const,
    memoryModel: "faux/default",
  };
  const faux = fauxProvider({
    models: [
      { id: "default", reasoning: true },
      { id: "worker", reasoning: true },
      { id: "changed", reasoning: true },
    ],
  });
  const app = fastify();
  let runtime: Runtime | undefined;
  let closeStreams: (() => void) | undefined;
  let release!: () => void;
  const preparation = new Promise<{}>((resolve) => {
    release = () => resolve({});
  });
  try {
    runtime = await Runtime.open(config, {
      beforeStart: (opened) => opened.models.registerNativeProvider(faux.provider),
    });
    runtime.orchestration.setPrepareAgent(async () => preparation);
    closeStreams = registerSessionRoutes(
      app,
      runtime,
      new TranscriptImages(join(directory, "previews")),
    );
    const started = await runtime.orchestration.nodeCommand("peer", "start", {
      action: "run",
      workspaceId: "work",
      prompt: "hold while model metadata is inspected",
      model: "faux/worker",
      effort: "medium",
    });
    expect(started.isError, JSON.stringify(started.output)).not.toBe(true);
    const [worker] = await runtime.orchestration.listRunning(runtime.main.id);
    expect(worker).toBeDefined();
    const url = "/api/sessions/main/subagents";
    const response = await app.inject(url);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({
        sessionId: worker!.sessionId,
        model: "faux/worker",
        thinkingLevel: "medium",
        parentSessionId: String(runtime.main.id),
        sessionPath: `durable:${worker!.sessionId}`,
      }),
    ]);

    const conversation = await runtime.conversation(worker!.sessionId);
    await conversation.configure(
      { model: { provider: "faux", modelId: "changed" }, thinkingLevel: "high" },
      context,
    );
    expect((await app.inject(url)).json()).toEqual([
      expect.objectContaining({ model: "faux/changed", thinkingLevel: "high" }),
    ]);
    const second = await runtime.orchestration.nodeCommand("peer", "start-second", {
      action: "run",
      workspaceId: "work",
      prompt: "a worker with different settings",
      model: "faux/worker",
      effort: "low",
    });
    expect(second.isError, JSON.stringify(second.output)).not.toBe(true);
    const remote = {
      sessionId: "remote:peer:123",
      conversationId: 0,
      workspaceId: "peer/work",
      prompt: "remote work",
      sessionPath: "remote:peer:123",
      parentSessionId: String(runtime.main.id),
      model: "remote-provider/model",
      thinkingLevel: "medium",
      startedAtMs: 123,
    };
    const remoteTasks = vi.spyOn(runtime.remotes, "tasks").mockReturnValue([remote]);
    const tasks = (await app.inject(url)).json();
    expect(tasks).toHaveLength(3);
    expect(tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ model: "faux/changed", thinkingLevel: "high" }),
        expect.objectContaining({ model: "faux/worker", thinkingLevel: "low" }),
        remote,
      ]),
    );
    expect(remoteTasks).toHaveBeenCalledWith(runtime.main.id);
    remoteTasks.mockRestore();
    expect((await app.inject("/api/sessions/99999999/subagents")).statusCode).toBe(404);
  } finally {
    closeStreams?.();
    await app.close();
    release();
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
});
