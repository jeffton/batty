// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test, vi } from "vite-plus/test";
import { fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { loadConfig } from "../config";
import { Runtime, context } from "../runtime";
import { TranscriptImages } from "../transcript-images";
import { createSessionOperations } from "../session-api";

test("main native input replaces a persisted model and follows changed settings without restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "batty-default-model-"));
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
  const faux = fauxProvider({ models: [{ id: "default" }, { id: "old" }, { id: "new" }] });
  faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage([fauxText("done")])));
  let runtime: Runtime | undefined;
  const open = () =>
    Runtime.open(config, {
      beforeStart: (opened) => opened.models.registerNativeProvider(faux.provider),
    });
  try {
    runtime = await open();
    await runtime.main.configure(
      { model: { provider: "faux", modelId: "old" }, thinkingLevel: "high" },
      context,
    );
    await runtime.close();
    runtime = await open();
    expect((await runtime.main.agent(context)).model?.modelId).toBe("old");
    const operations = createSessionOperations(runtime, {
      transcriptImages: new TranscriptImages(join(directory, "previews")),
    });
    const call = async (name: string, input: unknown) =>
      (await operations.get(name)!(input, { signal: new AbortController().signal })).value;
    for (const [kind, model] of [
      ["prompt", "default"],
      ["steer", "new"],
    ] as const) {
      config.defaultModel = model;
      const response = (await call("main.submit", { kind, text: "which model?", files: [] })) as {
        submissionId: string;
      };
      const submission = await runtime.harness.submission(
        Number(response.submissionId) as never,
        context,
      );
      expect((await submission!.wait(context)).status).toBe("done");
      expect((await runtime.main.agent(context)).model?.modelId).toBe(model);
      expect((await runtime.main.agent(context)).thinkingLevel).toBe("off");
      const state = await runtime.state();
      expect(state.messages.filter((message) => message.role === "assistant").at(-1)?.model).toBe(
        model,
      );
    }

    for (const operation of ["session.get", "session.messages"])
      await expect(call(operation, { sessionId: "99999999" })).rejects.toMatchObject({
        statusCode: 404,
      });

    for (const sessionId of ["main", "99999999"])
      await expect(call("session.stop", { sessionId })).rejects.toMatchObject({
        statusCode: 404,
        message: `Subagent session ${sessionId} not found. Start a new subagent instead.`,
      });
  } finally {
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
});
