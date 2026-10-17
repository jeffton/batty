// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test, vi } from "vite-plus/test";
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
      { id: "selected", name: "Chosen site", url: "/chosen", public: false },
      {
        id: "browser-live-session",
        browserId: "live-session",
        name: "Cloud browser",
        url: "/api/cloud-browser/live-session/state",
        public: false,
      },
    ],
  };
  const inventory = {
    sentFiles: selected.sentFiles,
    fileChanges: [...selected.fileChanges, { path: "draft.ts", patch: "discarded draft" }],
    sites: [...selected.sites, { id: "draft", name: "Draft", url: "/draft", public: false }],
  };
  const faux = fauxProvider({ models: [{ id: "artifact-test" }] });
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("attach_artifacts", { refs: artifactRefs(selected).map((item) => item.ref) })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("Chosen output")]),
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
    await (
      await runtime.main.submit(
        {
          type: "input",
          content: encodeRuntimeNotice({
            kind: "subagent",
            text: "Saved artifacts",
            data: { runtimeResultArtifacts: inventory, subagent: { sessionId: "42" } },
          }),
        },
        context,
      )
    ).wait(context);
    const check = async () => {
      const response = (await runtime!.messages(mainId)).messages.findLast(
        (message) => message.role === "assistant",
      );
      expect(response).toMatchObject(selected);
      if (response?.role === "assistant") {
        expect(response.fileChanges).toHaveLength(2);
        expect(response.sentFiles).toEqual(selected.sentFiles);
        expect(response.sites).toEqual(selected.sites);
      }
    };
    await check();
    await runtime.close();
    runtime = await open();
    await check();
  } finally {
    await runtime?.close();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 20000);
