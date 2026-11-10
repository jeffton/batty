import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, expect, test, vi } from "vite-plus/test";
import {
  RpcChannel,
  RpcError,
  RPC_CHUNK_BYTES,
  RPC_WINDOW_CHUNKS,
  type ChannelSocket,
  type RpcContext,
  type RpcHandler,
  type RpcReply,
} from "./channel";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function pair(handle?: RpcHandler, clientHandle?: RpcHandler) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener");
  const accepted = new Promise<RpcChannel>((resolve) => {
    server.once("connection", (socket) => resolve(new RpcChannel(socket, { handle })));
  });
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const client = await new Promise<RpcChannel>((resolve, reject) => {
    socket.once("open", () => resolve(new RpcChannel(socket, { handle: clientHandle })));
    socket.once("error", reject);
  });
  const remote = await accepted;
  cleanups.push(async () => {
    client.close();
    remote.close();
    for (const peer of server.clients) peer.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { client, remote, socket };
}

function bytes(value: Uint8Array) {
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        controller.enqueue(value);
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
}

async function readBytes(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    chunks.push(item.value);
  }
  return Buffer.concat(chunks);
}

test("native calls carry structured input/results concurrently in both directions", async () => {
  const { client, remote } = await pair(
    async (operation, input) => ({ value: { peer: "server", operation, input } }),
    async (operation, input) => ({ value: { peer: "client", operation, input } }),
  );
  expect(
    await Promise.all([
      client.call("session.get", { id: 42 }),
      remote.call("node.identity", { nonce: "test" }),
    ]),
  ).toEqual([
    { value: { peer: "server", operation: "session.get", input: { id: 42 } } },
    { value: { peer: "client", operation: "node.identity", input: { nonce: "test" } } },
  ]);
});

test("domain errors retain code/message and internal failures do not expose implementation details", async () => {
  const { client } = await pair(async (operation) => {
    if (operation === "missing") throw new RpcError("NOT_FOUND", "Session does not exist");
    throw new Error("private filesystem path or credential");
  });
  await expect(client.call("missing", null)).rejects.toMatchObject({
    code: "NOT_FOUND",
    message: "Session does not exist",
  });
  await expect(client.call("failure", null)).rejects.toMatchObject({
    code: "INTERNAL",
    message: "RPC operation failed",
  });
  const withoutHandler = await pair();
  await expect(withoutHandler.client.call("missing", null)).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});

test("binary uploads/downloads use native body lanes, preserving bytes and large source chunks", async () => {
  const input = new Uint8Array(RPC_CHUNK_BYTES * 3 + 23).map((_, index) => index % 251);
  const { client } = await pair(async (operation, metadata, context) => {
    expect(operation).toBe("file.transform");
    expect(metadata).toEqual({ name: "blob.bin" });
    const uploaded = await readBytes(context.body!);
    expect(uploaded).toEqual(Buffer.from(input));
    return { value: { length: uploaded.length }, body: bytes(uploaded.reverse()) };
  });
  const reply = await client.call("file.transform", { name: "blob.bin" }, { body: bytes(input) });
  expect(reply.value).toEqual({ length: input.length });
  expect(await readBytes(reply.body!)).toEqual(Buffer.from(input).reverse());
});

test("object events and binary output finish independently and neither truncates the other", async () => {
  const finishEvents = Promise.withResolvers<void>();
  let context!: RpcContext;
  const { client } = await pair(async (_operation, _input, ctx) => {
    context = ctx;
    return {
      value: { subscribed: true },
      body: bytes(new Uint8Array([0, 255, 1])),
      events: new ReadableStream<unknown>(
        {
          start(controller) {
            controller.enqueue({ type: "progress", fraction: 0.5 });
            controller.enqueue(null);
            controller.enqueue(false);
            void finishEvents.promise.then(() => {
              controller.enqueue({ type: "done" });
              controller.close();
            });
          },
        },
        { highWaterMark: 0 },
      ),
    };
  });
  const reply = await client.call("build.watch", null);
  expect(await readBytes(reply.body!)).toEqual(Buffer.from([0, 255, 1]));
  expect(context.signal.aborted).toBe(false);
  const events = reply.events!.getReader();
  expect((await events.read()).value).toEqual({ type: "progress", fraction: 0.5 });
  expect((await events.read()).value).toBe(null);
  expect((await events.read()).value).toBe(false);
  finishEvents.resolve();
  expect((await events.read()).value).toEqual({ type: "done" });
  expect((await events.read()).done).toBe(true);
  expect(context.signal.aborted).toBe(false);
});

test("event production is lazy and bounded when the event consumer stops reading", async () => {
  let produced = 0;
  let cancelled = false;
  const { client } = await pair(async () => ({
    value: null,
    events: new ReadableStream<unknown>(
      {
        pull(controller) {
          controller.enqueue({ sequence: produced++ });
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    ),
  }));
  const reply = await client.call("node.catalog.watch", null);
  await setImmediate();
  expect(produced).toBe(0);
  const reader = reply.events!.getReader();
  expect((await reader.read()).value).toEqual({ sequence: 0 });
  await vi.waitFor(() => expect(produced).toBe(RPC_WINDOW_CHUNKS));
  await setImmediate();
  expect(produced).toBe(RPC_WINDOW_CHUNKS);
  await reader.cancel();
  await vi.waitFor(() => expect(cancelled).toBe(true));
});

test("AbortSignal.reason survives before and after admission; cancellation aborts all call-scoped streams", async () => {
  let context!: RpcContext;
  let bodyCancelled = false;
  let eventsCancelled = false;
  const { client } = await pair(async (_operation, _input, ctx) => {
    context = ctx;
    return {
      value: null,
      body: new ReadableStream<Uint8Array>(
        {
          cancel() {
            bodyCancelled = true;
          },
        },
        { highWaterMark: 0 },
      ),
      events: new ReadableStream<unknown>(
        {
          cancel() {
            eventsCancelled = true;
          },
        },
        { highWaterMark: 0 },
      ),
    };
  });
  const before = AbortSignal.abort("pre-aborted reason");
  await expect(client.call("watch", null, { signal: before })).rejects.toBe("pre-aborted reason");
  const controller = new AbortController();
  const reply = await client.call("watch", null, { signal: controller.signal });
  const reason = new Error("Caller stopped watching");
  const bodyRead = expect(reply.body!.getReader().read()).rejects.toBe(reason);
  const eventRead = expect(reply.events!.getReader().read()).rejects.toBe(reason);
  controller.abort(reason);
  await Promise.all([bodyRead, eventRead]);
  await vi.waitFor(() => expect(context.signal.aborted).toBe(true));
  expect(bodyCancelled).toBe(true);
  expect(eventsCancelled).toBe(true);
});

test("cancelling an admitted call before its result aborts the handler and its upload", async () => {
  const admitted = Promise.withResolvers<RpcContext>();
  let uploadCancelled = false;
  const reply = Promise.withResolvers<{ value: unknown }>();
  const { client } = await pair(async (_operation, _input, context) => {
    admitted.resolve(context);
    return reply.promise;
  });
  const controller = new AbortController();
  const pending = client.call("command", null, {
    signal: controller.signal,
    body: new ReadableStream<Uint8Array>(
      {
        cancel() {
          uploadCancelled = true;
        },
      },
      { highWaterMark: 0 },
    ),
  });
  const context = await admitted.promise;
  const rejected = expect(pending).rejects.toBe(0);
  controller.abort(0);
  await rejected;
  await vi.waitFor(() => expect(context.signal.aborted).toBe(true));
  expect(uploadCancelled).toBe(true);
  reply.resolve({ value: "late result ignored" });
});

test("cancelling either output stream cancels the whole call, not unrelated calls", async () => {
  let context!: RpcContext;
  const { client } = await pair(async (operation, _input, ctx) => {
    if (operation === "identity") return { value: "ready" };
    context = ctx;
    return {
      value: null,
      body: new ReadableStream<Uint8Array>({}, { highWaterMark: 0 }),
      events: new ReadableStream<unknown>({}, { highWaterMark: 0 }),
    };
  });
  const reply = await client.call("watch", null);
  const failedBody = expect(reply.body!.getReader().read()).rejects.toMatchObject({
    code: "CANCELLED",
  });
  await reply.events!.cancel();
  await failedBody;
  await vi.waitFor(() => expect(context.signal.aborted).toBe(true));
  expect((await client.call("identity", null)).value).toBe("ready");
});

test("disconnect rejects pending calls and live streams; new connections never replay calls", async () => {
  const calls: unknown[] = [];
  const admitted = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<{ value: unknown }>();
  const handle: RpcHandler = async (operation, input) => {
    if (operation === "command") {
      calls.push(input);
      admitted.resolve();
      return reply.promise;
    }
    if (operation === "identity") return { value: "ready" };
    return { value: null, events: new ReadableStream<unknown>({}, { highWaterMark: 0 }) };
  };
  const { client, socket } = await pair(handle);
  const pending = expect(client.call("command", { id: 1 })).rejects.toMatchObject({
    code: "OFFLINE",
  });
  await admitted.promise;
  const watch = await client.call("watch", null);
  const streamFailure = expect(watch.events!.getReader().read()).rejects.toMatchObject({
    code: "OFFLINE",
  });
  socket.terminate();
  await Promise.all([pending, streamFailure, client.closed]);
  await expect(client.call("identity", null)).rejects.toMatchObject({ code: "OFFLINE" });
  const next = await pair(handle);
  expect((await next.client.call("identity", null)).value).toBe("ready");
  expect(calls).toEqual([{ id: 1 }]);
  reply.resolve({ value: "late" });
});

/** Frames cross a simulated delayed link only on advance(), giving deterministic RTT tests. */
function delayedLink(handle: RpcHandler, holdEnds = false) {
  let deliveries: (() => void)[] = [];
  const ends: (() => void)[] = [];
  type Endpoint = ChannelSocket & { peer?: Endpoint; emit(type: string, data?: unknown): void };
  function endpoint(): Endpoint {
    const listeners = new Map<string, ((event: { data: unknown }) => void)[]>();
    return {
      binaryType: "arraybuffer",
      peer: undefined as Endpoint | undefined,
      send(data: string | Uint8Array<ArrayBuffer>) {
        const value = typeof data === "string" ? data : data.slice().buffer;
        const delivery = () => this.peer!.emit("message", value);
        if (holdEnds && typeof data === "string" && JSON.parse(data).type === "end")
          ends.push(delivery);
        else deliveries.push(delivery);
      },
      close() {},
      addEventListener(type: string, listener: (event: { data: unknown }) => void) {
        const entries = listeners.get(type) ?? [];
        entries.push(listener);
        listeners.set(type, entries);
      },
      emit(type: string, data?: unknown) {
        for (const listener of listeners.get(type) ?? []) listener({ data });
      },
    };
  }
  const left = endpoint();
  const right = endpoint();
  left.peer = right;
  right.peer = left;
  const client = new RpcChannel(left);
  const remote = new RpcChannel(right, { handle });
  cleanups.push(async () => {
    client.close();
    remote.close();
  });
  return {
    client,
    remote,
    left,
    right,
    releaseEnds() {
      deliveries.push(...ends.splice(0));
    },
    async advance() {
      // Socket writes are serialized asynchronously; let admitted writes reach the link.
      await setImmediate();
      const current = deliveries;
      deliveries = [];
      for (const delivery of current) delivery();
      await setImmediate();
    },
  };
}

test("closed channels ignore previously queued calls instead of invoking handlers", async () => {
  let handled = 0;
  const link = delayedLink(async () => {
    handled++;
    return { value: null };
  });
  const pending = expect(link.client.call("command", null)).rejects.toMatchObject({
    code: "OFFLINE",
  });
  link.remote.close();
  await link.advance();
  expect(handled).toBe(0);
  link.client.close();
  await pending;
});

test("an early acknowledgement leaves the upload alive until its consumer finishes", async () => {
  let upload!: ReadableStreamDefaultController<Uint8Array>;
  let context!: RpcContext;
  const consumed = Promise.withResolvers<Buffer>();
  const { client } = await pair(async (_operation, _input, ctx) => {
    context = ctx;
    void readBytes(ctx.body!).then(consumed.resolve, consumed.reject);
    return { value: "accepted" };
  });
  const reply = await client.call("upload", null, {
    body: new ReadableStream<Uint8Array>(
      {
        start(controller) {
          upload = controller;
        },
      },
      { highWaterMark: 0 },
    ),
  });
  expect(reply.value).toBe("accepted");
  upload.enqueue(new Uint8Array([1, 2, 255]));
  upload.close();
  expect(await consumed.promise).toEqual(Buffer.from([1, 2, 255]));
  expect(context.signal.aborted).toBe(false);
});

test("late streaming replies clean up both streams even when cancellation hooks reject", async () => {
  const admitted = Promise.withResolvers<RpcContext>();
  const reply = Promise.withResolvers<RpcReply>();
  const { client } = await pair(async (_operation, _input, context) => {
    admitted.resolve(context);
    return reply.promise;
  });
  const controller = new AbortController();
  const pending = expect(client.call("watch", null, { signal: controller.signal })).rejects.toThrow(
    "stop",
  );
  const context = await admitted.promise;
  controller.abort(new Error("stop"));
  await pending;
  await vi.waitFor(() => expect(context.signal.aborted).toBe(true));
  const cancelled: string[] = [];
  reply.resolve({
    value: null,
    body: new ReadableStream<Uint8Array>({
      cancel() {
        cancelled.push("body");
        throw new Error("body cleanup failed");
      },
    }),
    events: new ReadableStream<unknown>({
      cancel() {
        cancelled.push("events");
        throw new Error("event cleanup failed");
      },
    }),
  });
  await vi.waitFor(() => expect(cancelled).toEqual(["body", "events"]));
  await setImmediate();
});

test("delayed binary transfer pipelines windows rather than paying an RTT per chunk", async () => {
  const total = RPC_WINDOW_CHUNKS * 4;
  let produced = 0;
  const link = delayedLink(async () => ({
    value: { chunks: total },
    body: new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (produced === total) controller.close();
          else controller.enqueue(new Uint8Array(RPC_CHUNK_BYTES).fill(produced++));
        },
      },
      { highWaterMark: 0 },
    ),
  }));
  let finished = false;
  const download = (async () => {
    const reply = await link.client.call("file", null);
    const reader = reply.body!.getReader();
    let received = 0;
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      expect(item.value).toEqual(new Uint8Array(RPC_CHUNK_BYTES).fill(received++));
    }
    expect(received).toBe(total);
    finished = true;
  })();
  for (let delay = 0; delay < 16 && !finished; delay++) await link.advance();
  expect(finished).toBe(true);
  await download;
});

test("a stalled binary consumer bounds queued plus in-flight chunks and cancels production", async () => {
  let produced = 0;
  let cancelled = false;
  const link = delayedLink(async () => ({
    value: null,
    body: new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          produced++;
          controller.enqueue(new Uint8Array(RPC_CHUNK_BYTES));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    ),
  }));
  const response = link.client.call("file", null);
  await link.advance();
  await link.advance();
  const reader = (await response).body!.getReader();
  expect(produced).toBe(0);
  const first = reader.read();
  for (let delay = 0; delay < 6; delay++) await link.advance();
  expect((await first).value!.length).toBe(RPC_CHUNK_BYTES);
  expect(produced).toBe(RPC_WINDOW_CHUNKS);
  await reader.read();
  for (let delay = 0; delay < 6; delay++) await link.advance();
  expect(produced - 2).toBeLessThanOrEqual(RPC_WINDOW_CHUNKS);
  await reader.cancel();
  await link.advance();
  expect(cancelled).toBe(true);
});

test("upload replenishment credits crossing EOF do not kill an active call", async () => {
  const admitted = Promise.withResolvers<RpcContext>();
  const reply = Promise.withResolvers<{ value: unknown }>();
  const link = delayedLink(async (_operation, _input, context) => {
    admitted.resolve(context);
    return reply.promise;
  }, true);
  const pending = link.client.call("command", null, {
    body: bytes(new Uint8Array(RPC_CHUNK_BYTES * 2)),
  });
  await link.advance();
  const reader = (await admitted.promise).body!.getReader();
  const first = reader.read();
  await link.advance();
  await link.advance();
  expect((await first).value!.length).toBe(RPC_CHUNK_BYTES);
  expect((await reader.read()).value!.length).toBe(RPC_CHUNK_BYTES);
  await link.advance();
  link.releaseEnds();
  await link.advance();
  expect((await reader.read()).done).toBe(true);
  reply.resolve({ value: "done" });
  await link.advance();
  await link.advance();
  expect((await pending).value).toBe("done");
});

test("heartbeat fails pending calls when the peer stops responding", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  const link = delayedLink(async () => new Promise(() => {}));
  const pending = expect(link.client.call("pending", null)).rejects.toMatchObject({
    code: "OFFLINE",
  });
  // No link advance: the peer cannot answer heartbeats.
  await vi.advanceTimersByTimeAsync(45_000);
  await pending;
  await link.client.closed;
});

test("heartbeat keeps a responsive idle channel alive across multiple liveness intervals", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  const link = delayedLink(async () => ({ value: "ready" }));
  for (let interval = 0; interval < 8; interval++) {
    await vi.advanceTimersByTimeAsync(15_000);
    await link.advance();
    await link.advance();
  }
  const result = link.client.call("identity", null);
  await link.advance();
  await link.advance();
  expect((await result).value).toBe("ready");
});

test("large native events and structured domain error details survive the wire", async () => {
  const value = { type: "reset", history: "x".repeat(RPC_CHUNK_BYTES * 3) };
  const { client } = await pair(async (operation) => {
    if (operation === "browser.select")
      throw new RpcError("SELECTION_CHANGED", "Choose a page", { pages: [{ id: "new-page" }] });
    return {
      value: null,
      events: new ReadableStream<unknown>(
        {
          start(controller) {
            controller.enqueue(value);
            controller.close();
          },
        },
        { highWaterMark: 0 },
      ),
    };
  });
  const reply = await client.call("session.watch", null);
  const reader = reply.events!.getReader();
  expect((await reader.read()).value).toEqual(value);
  expect((await reader.read()).done).toBe(true);
  await expect(client.call("browser.select", null)).rejects.toMatchObject({
    code: "SELECTION_CHANGED",
    details: { pages: [{ id: "new-page" }] },
  });
});
