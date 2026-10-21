// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import fastify from "fastify";
import multipart from "@fastify/multipart";
import { expect, test, vi } from "vite-plus/test";
import { fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { loadConfig } from "../config";
import { Runtime, context } from "../runtime";
import { TranscriptImages } from "../transcript-images";
import { registerSessionRoutes } from "./sessions";
import { streamAppStatus } from "../app-status-stream";
import { applyServerEvent } from "@/client/lib/session-events";
import { sessionHistoryCursor } from "@/client/lib/session-stream";
import type { ServerEvent, SessionState } from "@/shared/types";

test("multipart image → durable receipt → SSE → backend reopen reconciles without duplicate inputs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "batty-session-http-"));
  vi.stubEnv("PI_OFFLINE", "1");
  await mkdir(join(directory, ".batty"));
  await mkdir(join(directory, "work"));
  await writeFile(
    join(directory, ".batty/options.json"),
    JSON.stringify({
      workspacesRoots: [directory],
      webPushSubject: "mailto:test@example.com",
      baseUrl: "/batty",
    }),
  );
  const config = {
    ...(await loadConfig(directory)),
    selfPath: join(directory, "work"),
    defaultProvider: "faux",
    defaultModel: "http-test",
    defaultThinkingLevel: "off" as const,
    memoryModel: "faux/http-test",
  };
  const faux = fauxProvider({ models: [{ id: "http-test" }] });
  faux.setResponses(
    Array.from({ length: 40 }, () => fauxAssistantMessage([fauxText("image received")])),
  );
  let runtime: Runtime | undefined;
  let app: ReturnType<typeof fastify> | undefined;
  let closeStreams: (() => void) | undefined;
  let abort: AbortController | undefined;
  const open = async () => {
    runtime = await Runtime.open(config, {
      beforeStart: (opened) => {
        opened.models.registerNativeProvider(faux.provider);
      },
    });
    app = fastify();
    await app.register(multipart);
    closeStreams = registerSessionRoutes(
      app,
      runtime,
      new TranscriptImages(join(directory, "previews"), config.baseUrl),
      undefined,
      (stream) =>
        streamAppStatus(stream, runtime!, "fixture-build", (error) => {
          throw error;
        }),
    );
    return app.listen({ host: "127.0.0.1", port: 0 });
  };
  const close = async () => {
    abort?.abort();
    closeStreams?.();
    await app?.close();
    await runtime?.close();
    app = undefined;
    runtime = undefined;
  };
  async function stream(url: string) {
    abort = new AbortController();
    const response = await fetch(url, { signal: abort.signal });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    let buffer = "";
    return async (matches: (event: ServerEvent) => boolean): Promise<ServerEvent> => {
      for (;;) {
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const packet = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = packet.split("\n").find((line) => line.startsWith("data: "));
          if (!data || !packet.startsWith("data:")) continue;
          const event = JSON.parse(data.slice(6)) as ServerEvent;
          if (matches(event)) return event;
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error("SSE closed before expected receipt");
        buffer += new TextDecoder().decode(chunk.value);
      }
    };
  }
  try {
    let url = await open();
    const nextEvent = await stream(`${url}/api/main/events`);
    expect(await nextEvent((event) => event.type === "build")).toEqual({
      type: "build",
      buildId: "fixture-build",
    });
    expect(await nextEvent((event) => event.type === "auth-attempts")).toEqual({
      type: "auth-attempts",
      provider: [],
      mcp: [],
    });
    let client = applyServerEvent(undefined, await nextEvent((event) => event.type === "reset"));
    const form = new FormData();
    form.set("text", "HTTP image test");
    form.set("clientMessageId", "http-image-id");
    form.set(
      "files",
      new Blob(
        [
          Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlXcAAAAASUVORK5CYII=",
            "base64",
          ),
        ],
        { type: "image/png" },
      ),
      "pixel.png",
    );
    const receiptResponse = await fetch(`${url}/api/main/prompt`, { method: "POST", body: form });
    expect(receiptResponse.status).toBe(200);
    const receipt = (await receiptResponse.json()) as { submissionId: string };
    await nextEvent((event) => {
      client = applyServerEvent(client, event);
      return (
        client?.messages.some(
          (message) =>
            message.role === "assistant" && JSON.stringify(message).includes("image received"),
        ) ?? false
      );
    });
    const user = client!.messages.find(
      (message) => message.role === "user" && message.clientMessageId === "http-image-id",
    )!;
    expect(user).toMatchObject({
      blocks: [
        { type: "text", text: "HTTP image test" },
        {
          type: "image",
          url: expect.stringMatching(/^\/batty\/api\/transcript-images\//),
          previewUrl: expect.stringMatching(/^\/batty\/api\/transcript-images\/.*\?preview=1$/),
        },
      ],
    });
    expect(JSON.stringify((await runtime!.main.context(context)).messages)).toContain("pixel.png");
    expect(JSON.stringify(user)).not.toContain("iVBORw0KGgo");
    const cursor = client!.messages.at(-1)!.id;
    const beforeRestart = client!;
    await close();
    url = await open();
    await runtime!.main.commit(async (tx) => {
      for (let index = 0; index < 1000; index++)
        await tx.appendEntry(runtime!.main.id, { kind: "bookkeeping", data: { index } });
      await tx.appendEntry(runtime!.main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "written while disconnected", timestamp: Date.now() }],
      });
      for (let index = 0; index < 1000; index++)
        await tx.appendEntry(runtime!.main.id, { kind: "bookkeeping", data: { trailing: index } });
    }, context);
    const reconnected = await stream(`${url}/api/main/events?after=${encodeURIComponent(cursor)}`);
    client = beforeRestart;
    let catchupPages = 0;
    await reconnected((event) => {
      if (event.type === "reset") {
        catchupPages++;
        expect(event.state.messages.length).toBeLessThanOrEqual(120);
      }
      client = applyServerEvent(client, event);
      return (
        event.type === "reset" &&
        !event.state.hasMoreRecentMessages &&
        (client?.messages.some((message) =>
          JSON.stringify(message).includes("written while disconnected"),
        ) ??
          false)
      );
    });
    expect(catchupPages).toBeGreaterThanOrEqual(17);
    const rawCursor = sessionHistoryCursor(client)!;
    expect(Number(rawCursor)).toBeGreaterThan(Number(client!.messages.at(-1)!.id));
    abort!.abort();
    const secondReconnect = await stream(
      `${url}/api/main/events?after=${encodeURIComponent(rawCursor)}`,
    );
    const caughtUp = await secondReconnect((event) => event.type === "reset");
    if (caughtUp.type !== "reset") throw new Error("Expected reset");
    expect(caughtUp.state.messages).toEqual([]);
    expect(caughtUp.state.hasMoreRecentMessages).toBe(false);
    expect(caughtUp.state.historyCursor).toBe(rawCursor);
    client = applyServerEvent(client, caughtUp);
    const retry = await fetch(`${url}/api/main/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "HTTP image test", clientMessageId: "http-image-id" }),
    });
    expect(((await retry.json()) as { submissionId: string }).submissionId).toBe(
      receipt.submissionId,
    );
    const snapshot = (await (await fetch(`${url}/api/main`)).json()) as SessionState;
    expect(
      snapshot.messages.filter(
        (message) => message.role === "user" && message.clientMessageId === "http-image-id",
      ),
    ).toHaveLength(1);
    expect(
      client!.messages.filter(
        (message) => message.role === "user" && message.clientMessageId === "http-image-id",
      ),
    ).toHaveLength(1);
    expect(snapshot.totalMessageCount).toBe(beforeRestart.totalMessageCount + 1);

    // A large permanent archive must not be acquired via Pi's full UI view/watch.
    abort!.abort();
    await runtime!.main.commit(async (tx) => {
      for (let i = 0; i < 5000; i++)
        await tx.appendEntry(runtime!.main.id, {
          kind: "scaling-fixture",
          data: { text: `historic ${i}`, timestamp: Date.now() },
        });
      for (let i = 0; i < 5000; i++)
        await tx.appendEntry(runtime!.main.id, { kind: "bookkeeping", data: { tail: i } });
    }, context);
    const view = vi
      .spyOn(runtime!.main, "viewState")
      .mockRejectedValue(new Error("Full view forbidden"));
    const watch = vi
      .spyOn(runtime!.main, "watch")
      .mockRejectedValue(new Error("Full watch forbidden"));
    const scans = vi.spyOn(runtime!.storage, "scanEntries");
    const started = performance.now();
    const bounded = (await (await fetch(`${url}/api/main`)).json()) as SessionState;
    expect(bounded.messages).toHaveLength(120);
    expect(bounded.totalMessageCount).toBe(beforeRestart.totalMessageCount + 5001);
    expect(scans.mock.calls.filter(([query]) => query.minEntryId === undefined)).toHaveLength(0);
    const coldStream = await stream(`${url}/api/main/events`);
    const cold = await coldStream((event) => event.type === "reset");
    expect(cold.type === "reset" && cold.state.messages.length).toBe(120);
    expect(view).not.toHaveBeenCalled();
    expect(watch).not.toHaveBeenCalled();
    console.log(
      `runtime/SSE: 5,000 visible + 5,000 invisible archive entries open in ${(performance.now() - started).toFixed(1)}ms; 120-message state, zero cold archive scans/full views/watches`,
    );
  } finally {
    await close();
    await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
}, 15000);
