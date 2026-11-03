// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test, vi } from "vite-plus/test";
import fastify from "fastify";
import { registerSessionRoutes } from "./routes/sessions";
import { TranscriptImages } from "./transcript-images";
import type { ServerEvent } from "@/shared/types";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { loadConfig } from "./config";
import { Runtime, context } from "./runtime";
import { artifactRefs } from "./artifact-forwarding";
import { encodeRuntimeNotice } from "./runtime-notices";

test("Runtime response and reopened history reuse files and distinct same-path immutable diffs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "batty-forwarded-runtime-"));
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
    defaultModel: "artifact-test",
    defaultThinkingLevel: "off" as const,
    memoryModel: "faux/artifact-test",
  };
  const selected = {
    fileChanges: [
      { path: "a.ts", patch: "original saved patch\n" },
      { path: "a.ts", patch: "another original saved patch\n" },
    ],
    sentFiles: [
      {
        id: "original-file-id",
        name: "photo.png",
        size: 1,
        mimeType: "image/png",
        kind: "image" as const,
        downloadUrl: "/api/sent-files/original-file-id",
      },
    ],
    sites: [
      {
        kind: "site" as const,
        id: "selected",
        name: "Chosen site",
        url: "/chosen",
        public: false as const,
      },
      {
        kind: "browser" as const,
        id: "browser-live-session",
        browserId: "live-session",
        name: "Cloud browser",
        url: "/api/cloud-browser/live-session/state",
        public: false as const,
      },
    ],
  };
  const inventory = {
    sentFiles: selected.sentFiles,
    fileChanges: [...selected.fileChanges, { path: "draft.ts", patch: "discarded draft" }],
    sites: [
      ...selected.sites,
      {
        kind: "site" as const,
        id: "draft",
        name: "Draft",
        url: "/draft",
        public: false as const,
      },
    ],
  };
  const faux = fauxProvider({ models: [{ id: "artifact-test" }] });
  const awaitingFinal = Promise.withResolvers<void>();
  const releaseFinal = Promise.withResolvers<void>();
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("attach_artifacts", { refs: artifactRefs(selected).map((item) => item.ref) })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      [fauxText("Chosen output"), fauxToolCall("memory_search", { query: "nothing" })],
      { stopReason: "toolUse" },
    ),
    async () => {
      awaitingFinal.resolve();
      await releaseFinal.promise;
      return fauxAssistantMessage([fauxText("Unrelated worker result")]);
    },
  ]);
  let runtime: Runtime | undefined;
  const open = () =>
    Runtime.open(config, {
      beforeStart: (opened) => {
        opened.models.registerNativeProvider(faux.provider);
      },
    });
  try {
    runtime = await open();
    const mainId = String(runtime.main.id);
    const submission = await runtime.main.submit(
      {
        type: "input",
        content: encodeRuntimeNotice({
          kind: "subagent",
          text: "Saved artifacts",
          data: { runtimeResultArtifacts: inventory, subagent: { sessionId: "42" } },
        }),
      },
      context,
    );
    await awaitingFinal.promise;
    const check = async () => {
      const messages = (await runtime!.messages(mainId)).messages;
      const response = messages.find(
        (message) =>
          message.role === "assistant" &&
          message.blocks.some((block) => block.type === "text" && block.text === "Chosen output"),
      );
      expect(response).toMatchObject(selected);
      if (response?.role === "assistant") {
        expect(response.fileChanges).toHaveLength(2);
        expect(response.sentFiles).toEqual(selected.sentFiles);
        expect(response.sites).toEqual(selected.sites);
        expect(response.turnPhase).toBe("intermediate");
      }
      const final = messages.findLast(
        (message) => message.role === "assistant" && message.turnPhase === "final",
      );
      if (final?.role === "assistant") {
        expect(final.sentFiles).toBeUndefined();
        expect(final.sites).toBeUndefined();
        expect(final.fileChanges).toBeUndefined();
      }
      const tail = await runtime!.state(mainId, undefined, true, String(Number(response!.id) - 1));
      expect(tail.messages.find((message) => message.id === response!.id)).toMatchObject(selected);
      const app = fastify();
      const closeStreams = registerSessionRoutes(
        app,
        runtime!,
        new TranscriptImages(join(directory, "previews"), ""),
      );
      const abort = new AbortController();
      try {
        const url = await app.listen({ host: "127.0.0.1", port: 0 });
        const stream = await fetch(`${url}/api/main/events?after=${Number(response!.id) - 1}`, {
          signal: abort.signal,
        });
        const reader = stream.body!.getReader();
        let buffer = "";
        let reset: Extract<ServerEvent, { type: "reset" }> | undefined;
        while (!reset) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error("SSE closed before replay");
          buffer += new TextDecoder().decode(chunk.value);
          let end: number;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const packet = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const line = packet.split("\n").find((item) => item.startsWith("data: "));
            if (!line) continue;
            const event = JSON.parse(line.slice(6)) as ServerEvent;
            if (event.type === "reset") reset = event;
          }
        }
        expect(reset.state.messages.find((message) => message.id === response!.id)).toMatchObject(
          selected,
        );
      } finally {
        abort.abort();
        closeStreams();
        await app.close();
      }
    };
    // The commentary is already complete and projected while the run is still
    // waiting on another result, before any submission has a final answer.
    await check();
    releaseFinal.resolve();
    await submission.wait(context);
    await check();
    await runtime.close();
    runtime = await open();
    await check();
  } finally {
    releaseFinal.resolve();
    await runtime?.close();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 20000);
