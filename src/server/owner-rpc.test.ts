// @vitest-environment node
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, test, vi } from "vite-plus/test";
import { fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { createOwnerRpcHandler, type OwnerRpcServices } from "./owner-rpc";
import { Runtime } from "./runtime";
import { loadConfig } from "./config";
import { TranscriptImages } from "./transcript-images";
import { PushForeground } from "./push-foreground";
import { RpcError } from "../shared/rpc";

test("native owner operations read workspace files, stream search and reject workspace escapes without HTTP", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "batty-owner-native-"));
  try {
    await mkdir(path.join(directory, ".batty"));
    await mkdir(path.join(directory, "work"));
    await writeFile(path.join(directory, "work", "hello.ts"), "export const hello = 42;\n");
    await writeFile(
      path.join(directory, ".batty", "options.json"),
      JSON.stringify({ workspacesRoots: [directory], webPushSubject: "mailto:test@example.com" }),
    );
    const config = await loadConfig(directory);
    const handler = createOwnerRpcHandler({ config, tools: {} } as Runtime, {} as OwnerRpcServices);
    const rpc = { signal: new AbortController().signal };
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("Native operation attempted HTTP");
    });
    try {
      const { value } = await handler("workspace.list", {}, rpc);
      const workspace = (value as { workspaces: { id: string; label: string }[] }).workspaces.find(
        (workspace) => workspace.label === "work",
      )!;
      expect(workspace).toBeTruthy();
      const file = await handler(
        "workspace.file",
        { workspaceId: workspace.id, path: "hello.ts" },
        rpc,
      );
      expect(file.value).toMatchObject({ kind: "text", contents: "export const hello = 42;\n" });
      await expect(
        handler("workspace.file", { workspaceId: workspace.id, path: "../secret" }, rpc),
      ).rejects.toMatchObject({ code: "BAD_INPUT" });
      const search = await handler(
        "workspace.search",
        { workspaceId: workspace.id, name: "hello" },
        rpc,
      );
      const reader = search.events!.getReader();
      expect((await reader.read()).value).toEqual({ kind: "match", path: "hello.ts" });
      expect((await reader.read()).value).toEqual({ kind: "done" });
      expect((await reader.read()).done).toBe(true);
      await expect(handler("node.command", {}, rpc)).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("native prompt bytes become durable attachments and session events clean up on cancellation", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "batty-owner-session-"));
  let runtime: Runtime | undefined;
  vi.stubEnv("PI_OFFLINE", "1");
  try {
    await mkdir(path.join(directory, ".batty"));
    await mkdir(path.join(directory, "work"));
    await writeFile(
      path.join(directory, ".batty", "options.json"),
      JSON.stringify({
        workspacesRoots: [directory],
        webPushSubject: "mailto:test@example.com",
        baseUrl: "/batty",
      }),
    );
    const config = {
      ...(await loadConfig(directory)),
      selfPath: path.join(directory, "work"),
      defaultProvider: "faux",
      defaultModel: "native-test",
      defaultThinkingLevel: "off" as const,
      memoryModel: "faux/native-test",
    };
    const faux = fauxProvider({ models: [{ id: "native-test" }] });
    faux.setResponses([fauxAssistantMessage([fauxText("received")])]);
    runtime = await Runtime.open(config, {
      beforeStart: (opened) => opened.models.registerNativeProvider(faux.provider),
    });
    const handler = createOwnerRpcHandler(runtime, {
      transcriptImages: new TranscriptImages(path.join(directory, "images"), config.baseUrl),
      webPush: { foreground: new PushForeground() },
    } as OwnerRpcServices);
    const rpc = { signal: new AbortController().signal };
    const input = {
      kind: "prompt",
      text: "Read the attachment",
      clientMessageId: "native-input-1",
      files: [{ name: "notes.txt", type: "text/plain", size: 4 }],
    };
    const bytes = () =>
      new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(new TextEncoder().encode("data"));
          stream.close();
        },
      });
    const submission = await handler("main.submit", input, { ...rpc, body: bytes() });
    expect(submission.value).toMatchObject({ sessionId: String(runtime.main.id) });
    const duplicate = await handler("main.submit", input, { ...rpc, body: bytes() });
    expect(duplicate.value).toMatchObject({
      submissionId: (submission.value as { submissionId: string }).submissionId,
    });
    await expect(
      handler(
        "main.submit",
        {
          ...input,
          clientMessageId: "incomplete",
          files: [{ name: "bad.txt", type: "text/plain", size: 5 }],
        },
        { ...rpc, body: bytes() },
      ),
    ).rejects.toMatchObject({ code: "BAD_INPUT" });
    const events = await handler("session.watch", { sessionId: "main" }, rpc);
    const reader = events.events!.getReader();
    try {
      let event: unknown;
      do {
        event = (await reader.read()).value;
      } while ((event as { type: string }).type !== "reset");
      expect(event).toMatchObject({ type: "reset", state: { id: String(runtime.main.id) } });
    } finally {
      await reader.cancel();
    }
    await vi.waitFor(async () =>
      expect((await runtime!.state("main", undefined, false)).isStreaming).toBe(false),
    );
    await expect(
      handler("workspace.files", { workspaceId: "missing" }, rpc),
    ).rejects.toBeInstanceOf(RpcError);
  } finally {
    await runtime?.close();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});

test("browser native errors preserve selection pages and sanitize credential failures", async () => {
  const pages = [{ id: "tab-2" }];
  const browser = {
    cloudState: vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("Select a tab"), { statusCode: 409, pages })),
    fillCloudCredentials: vi.fn().mockRejectedValue(new Error("secret-value")),
  };
  const handler = createOwnerRpcHandler(
    { config: {}, tools: { browserService: browser } } as unknown as Runtime,
    {} as OwnerRpcServices,
  );
  const rpc = { signal: new AbortController().signal };
  await expect(handler("browser.state", { browserId: "browser-1" }, rpc)).rejects.toMatchObject({
    code: "SELECTION_CHANGED",
    details: { pages },
  });
  await expect(
    handler(
      "browser.credentials.fill",
      {
        browserId: "browser-1",
        credentials: {
          target: {
            loginId: "a",
            pageId: "b",
            revision: "c",
            url: "https://example.com",
            origin: "https://example.com",
            token: "d",
          },
          username: "test",
          password: "secret-value",
        },
      },
      rpc,
    ),
  ).rejects.toMatchObject({
    code: "INTERNAL",
    message: "Credential fill failed. Reopen the login panel and try again.",
  });
});
