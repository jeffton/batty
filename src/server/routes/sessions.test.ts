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
import { applyServerEvent } from "@/client/lib/session-events";
import { sessionHistoryCursor } from "@/client/lib/session-stream";
import type { ServerEvent, SessionState } from "@/shared/types";

test("native image → durable receipt → events → backend reopen reconciles without duplicate inputs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "batty-session-native-"));
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
    defaultModel: "native-test",
    defaultThinkingLevel: "off" as const,
    memoryModel: "faux/native-test",
  };
  const faux = fauxProvider({ models: [{ id: "native-test" }] });
  faux.setResponses(
    Array.from({ length: 40 }, () => fauxAssistantMessage([fauxText("image received")])),
  );
  let runtime: Runtime | undefined;
  let operations: ReturnType<typeof createSessionOperations>;
  let abort: AbortController | undefined;
  const open = async () => {
    runtime = await Runtime.open(config, {
      beforeStart: (opened) => {
        opened.models.registerNativeProvider(faux.provider);
      },
    });
    operations = createSessionOperations(runtime, {
      transcriptImages: new TranscriptImages(join(directory, "previews"), config.baseUrl),
      buildId: "fixture-build",
    });
  };
  const close = async () => {
    abort?.abort();
    await runtime?.close();
    runtime = undefined;
  };
  const call = async (operation: string, input: unknown, body?: ReadableStream<Uint8Array>) =>
    (await operations.get(operation)!(input, { signal: new AbortController().signal, body })).value;
  async function stream(after?: string) {
    abort = new AbortController();
    const response = await operations.get("session.watch")!(
      { sessionId: "main", after },
      { signal: abort.signal },
    );
    const reader = response.events!.getReader();
    return async (matches: (event: ServerEvent) => boolean): Promise<ServerEvent> => {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("Event stream closed before expected receipt");
        const event = chunk.value as ServerEvent;
        if (matches(event)) return event;
      }
    };
  }
  try {
    await open();
    const nextEvent = await stream();
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
    const image = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlXcAAAAASUVORK5CYII=",
      "base64",
    );
    const receipt = (await call(
      "main.submit",
      {
        kind: "prompt",
        text: "Native image test",
        clientMessageId: "native-image-id",
        files: [{ name: "pixel.png", type: "image/png", size: image.length }],
      },
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(image);
          controller.close();
        },
      }),
    )) as { submissionId: string };
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
      (message) => message.role === "user" && message.clientMessageId === "native-image-id",
    )!;
    expect(user).toMatchObject({
      blocks: [
        { type: "text", text: "Native image test" },
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
    await open();
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
    const reconnected = await stream(cursor);
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
    const secondReconnect = await stream(rawCursor);
    const caughtUp = await secondReconnect((event) => event.type === "reset");
    if (caughtUp.type !== "reset") throw new Error("Expected reset");
    expect(caughtUp.state.messages).toEqual([]);
    expect(caughtUp.state.hasMoreRecentMessages).toBe(false);
    expect(caughtUp.state.historyCursor).toBe(rawCursor);
    client = applyServerEvent(client, caughtUp);
    const retry = (await call("main.submit", {
      kind: "prompt",
      text: "Native image test",
      clientMessageId: "native-image-id",
      files: [],
    })) as { submissionId: string };
    expect(retry.submissionId).toBe(receipt.submissionId);
    const snapshot = (await call("session.get", { sessionId: "main" })) as SessionState;
    expect(
      snapshot.messages.filter(
        (message) => message.role === "user" && message.clientMessageId === "native-image-id",
      ),
    ).toHaveLength(1);
    expect(
      client!.messages.filter(
        (message) => message.role === "user" && message.clientMessageId === "native-image-id",
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
    const watch = vi
      .spyOn(runtime!.main, "watch")
      .mockRejectedValue(new Error("Full watch forbidden"));
    const scans = vi.spyOn(runtime!.storage, "scanEntries");
    const started = performance.now();
    const bounded = (await call("session.get", { sessionId: "main" })) as SessionState;
    expect(bounded.messages).toHaveLength(120);
    expect(bounded.totalMessageCount).toBe(beforeRestart.totalMessageCount + 5001);
    expect(scans.mock.calls.filter(([query]) => query.minEntryId === undefined)).toHaveLength(0);
    const coldStream = await stream();
    const cold = await coldStream((event) => event.type === "reset");
    expect(cold.type === "reset" && cold.state.messages.length).toBe(120);
    expect(watch).not.toHaveBeenCalled();
    console.log(
      `runtime/native events: 5,000 visible + 5,000 invisible archive entries open in ${(performance.now() - started).toFixed(1)}ms; 120-message state, zero cold archive scans/full views/watches`,
    );
  } finally {
    await close();
    await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
}, 15000);
