// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test, vi } from "vite-plus/test";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { loadConfig } from "../config";
import { Runtime, context } from "../runtime";
import { TranscriptImages } from "../transcript-images";
import { createSessionOperations } from "../session-api";

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
  let runtime: Runtime | undefined;
  let release!: () => void;
  const preparation = new Promise<{}>((resolve) => {
    release = () => resolve({});
  });
  try {
    runtime = await Runtime.open(config, {
      beforeStart: (opened) => opened.models.registerNativeProvider(faux.provider),
    });
    runtime.orchestration.setPrepareAgent(async () => preparation);
    const operations = createSessionOperations(runtime, {
      transcriptImages: new TranscriptImages(join(directory, "previews")),
    });
    const call = async (name: string, input: unknown) =>
      (await operations.get(name)!(input, { signal: new AbortController().signal })).value;
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
    const tasksForMain = () => call("session.subagents", { sessionId: "main" });
    expect(await tasksForMain()).toEqual([
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
    expect(await tasksForMain()).toEqual([
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
    const tasks = await tasksForMain();
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
    await expect(call("session.subagents", { sessionId: "99999999" })).rejects.toMatchObject({
      statusCode: 404,
    });
  } finally {
    release();
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
});
