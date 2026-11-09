import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, expect, test, vi } from "vite-plus/test";
import {
  SocketChannel,
  SOCKET_CHUNK_BYTES,
  SOCKET_WINDOW_CHUNKS,
  type ChannelSocket,
  type SocketHandler,
} from "./socket-channel";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function pair(handle: SocketHandler, clientHandle?: SocketHandler) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener");
  const accepted = new Promise<SocketChannel>((resolve) => {
    server.once("connection", (socket) => resolve(new SocketChannel(socket, { handle })));
  });
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const client = await new Promise<SocketChannel>((resolve, reject) => {
    socket.once("open", () => resolve(new SocketChannel(socket, { handle: clientHandle })));
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

function request(path = "identity", init?: RequestInit & { duplex?: "half" }) {
  return new Request(`https://peer.test/api/node/${path}`, init);
}

test("both peers can issue concurrent requests over the same socket", async () => {
  const { client, remote } = await pair(
    async (path) => Response.json({ peer: "server", path }),
    async (path) => Response.json({ peer: "client", path }),
  );
  const responses = await Promise.all([
    client.request("identity", request()),
    remote.request("workspaces", request("workspaces")),
  ]);
  expect(await Promise.all(responses.map((response) => response.json()))).toEqual([
    { peer: "server", path: "identity" },
    { peer: "client", path: "workspaces" },
  ]);
});

test("request bytes stay unread until the receiver pulls, with one bounded chunk per credit", async () => {
  let pulls = 0;
  const received = Promise.withResolvers<Request>();
  const reply = Promise.withResolvers<Response>();
  const { client } = await pair(async (_path, incoming) => {
    received.resolve(incoming);
    return reply.promise;
  });
  const bytes = new Uint8Array(SOCKET_CHUNK_BYTES * 2 + 17).map((_, index) => index % 251);
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls++;
        controller.enqueue(bytes);
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const controller = new AbortController();
  const pending = client.request(
    "commands",
    request("commands", {
      method: "POST",
      body,
      duplex: "half",
      signal: controller.signal,
    }),
  );
  const rejected = expect(pending).rejects.toThrow();
  const incoming = await received.promise;
  await setImmediate();
  expect(pulls).toBe(0);
  const reader = incoming.body!.getReader();
  for (const [start, end] of [
    [0, SOCKET_CHUNK_BYTES],
    [SOCKET_CHUNK_BYTES, SOCKET_CHUNK_BYTES * 2],
    [SOCKET_CHUNK_BYTES * 2, bytes.length],
  ]) {
    const chunk = await reader.read();
    expect(chunk.done).toBe(false);
    expect(chunk.value).toEqual(bytes.subarray(start, end));
    await setImmediate();
    expect(pulls).toBe(1);
  }
  controller.abort();
  await rejected;
  await vi.waitFor(() => expect(incoming.signal.aborted).toBe(true));
  reply.resolve(new Response(null, { status: 204 }));
});

test("response streaming is pull-driven and strips decoded HTTP framing", async () => {
  let pulls = 0;
  const { client } = await pair(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              pulls++;
              if (pulls === 3) controller.close();
              else controller.enqueue(new Uint8Array([pulls, 0, 255]));
            },
          },
          { highWaterMark: 0 },
        ),
        {
          headers: {
            "content-encoding": "gzip",
            "content-length": "123",
            "content-type": "application/octet-stream",
            "x-application": "preserved",
          },
        },
      ),
  );
  const response = await client.request("files/work/12/tool/file", request());
  expect(response.headers.get("content-type")).toBe("application/octet-stream");
  expect(response.headers.get("x-application")).toBe("preserved");
  expect(response.headers.has("content-encoding")).toBe(false);
  expect(response.headers.has("content-length")).toBe(false);
  await setImmediate();
  expect(pulls).toBe(0);
  const reader = response.body!.getReader();
  expect((await reader.read()).value).toEqual(new Uint8Array([1, 0, 255]));
  await setImmediate();
  expect(pulls).toBe(3);
  expect((await reader.read()).value).toEqual(new Uint8Array([2, 0, 255]));
  expect(await reader.read()).toEqual({ done: true, value: undefined });
});

test("abort after response headers cancels only that exchange and reaches the producer", async () => {
  let incoming!: Request;
  let cancelled = false;
  const { client } = await pair(async (path, req) => {
    if (path === "identity") return Response.json({ instanceId: "other" });
    incoming = req;
    return new Response(
      new ReadableStream<Uint8Array>(
        {
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      ),
    );
  });
  const controller = new AbortController();
  const response = await client.request(
    "catalog/events",
    request("catalog/events", { signal: controller.signal }),
  );
  const read = response.body!.getReader().read();
  const reason = new Error("Caller stopped the stream");
  const rejected = expect(read).rejects.toBe(reason);
  controller.abort(reason);
  await rejected;
  await vi.waitFor(() => expect(incoming.signal.aborted).toBe(true));
  expect(cancelled).toBe(true);
  expect(await (await client.request("identity", request())).json()).toEqual({
    instanceId: "other",
  });
});

test("consumer cancellation propagates to the producer without closing the socket", async () => {
  let cancelled = false;
  const { client } = await pair(async (path) =>
    path === "identity"
      ? Response.json({ instanceId: "other" })
      : new Response(
          new ReadableStream<Uint8Array>(
            {
              cancel() {
                cancelled = true;
              },
            },
            { highWaterMark: 0 },
          ),
        ),
  );
  const response = await client.request("catalog/events", request());
  await response.body!.cancel();
  await vi.waitFor(() => expect(cancelled).toBe(true));
  expect(await (await client.request("identity", request())).json()).toEqual({
    instanceId: "other",
  });
});

test("disconnect rejects admitted commands and active streams, and a new socket does not replay them", async () => {
  const commands: string[] = [];
  const admitted = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<Response>();
  const handle: SocketHandler = async (path, incoming) => {
    if (path === "commands") {
      commands.push(await incoming.text());
      admitted.resolve();
      return reply.promise;
    }
    if (path === "identity") return Response.json({ instanceId: "other" });
    return new Response(new ReadableStream<Uint8Array>({}, { highWaterMark: 0 }));
  };
  const { client, socket } = await pair(handle);
  const pending = client.request(
    "commands",
    request("commands", { method: "POST", body: "one command" }),
  );
  const rejected = expect(pending).rejects.toThrow(/disconnected|failed/i);
  await admitted.promise;
  const stream = await client.request("catalog/events", request());
  const brokenStream = expect(stream.body!.getReader().read()).rejects.toThrow(
    /disconnected|failed/i,
  );
  socket.terminate();
  await Promise.all([rejected, brokenStream, client.closed]);
  await expect(client.request("identity", request())).rejects.toThrow("offline");
  const next = await pair(handle);
  expect(await (await next.client.request("identity", request())).json()).toEqual({
    instanceId: "other",
  });
  expect(commands).toEqual(["one command"]);
  reply.resolve(new Response(null, { status: 204 }));
});

/** Each flush advances one one-way link delay, without wall-clock timing assertions. */
function delayedLink(handle: SocketHandler, holdEnds = false) {
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
  const client = new SocketChannel(left as ChannelSocket);
  const remote = new SocketChannel(right as ChannelSocket, { handle });
  cleanups.push(async () => {
    client.close();
    remote.close();
  });
  return {
    client,
    releaseEnds() {
      deliveries.push(...ends.splice(0));
    },
    async advance() {
      const current = deliveries;
      deliveries = [];
      for (const delivery of current) delivery();
      await setImmediate();
    },
  };
}

test("a delayed link pipelines a file window instead of spending an RTT per chunk", async () => {
  const total = SOCKET_WINDOW_CHUNKS * 4;
  let produced = 0;
  const link = delayedLink(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              if (produced === total) controller.close();
              else controller.enqueue(new Uint8Array(SOCKET_CHUNK_BYTES).fill(produced++));
            },
          },
          { highWaterMark: 0 },
        ),
      ),
  );
  let finished = false;
  const download = (async () => {
    const response = await link.client.request("file", request());
    const reader = response.body!.getReader();
    let received = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      expect(chunk.value).toEqual(new Uint8Array(SOCKET_CHUNK_BYTES).fill(received++));
    }
    expect(received).toBe(total);
    finished = true;
  })();
  // 64 chunks previously needed >=128 one-way body delays. Four windows need
  // only a handful of RTTs, including headers and EOF; no throughput clock flake.
  for (let delay = 0; delay < 16 && !finished; delay++) await link.advance();
  expect(finished).toBe(true);
  await download;
});

test("a stalled consumer bounds queued plus in-flight data to the protocol window", async () => {
  let produced = 0;
  let cancelled = false;
  const link = delayedLink(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              produced++;
              controller.enqueue(new Uint8Array(SOCKET_CHUNK_BYTES));
            },
            cancel() {
              cancelled = true;
            },
          },
          { highWaterMark: 0 },
        ),
      ),
  );
  const responsePromise = link.client.request("file", request());
  await link.advance();
  await link.advance();
  const response = await responsePromise;
  expect(produced).toBe(0);
  const reader = response.body!.getReader();
  const first = reader.read();
  for (let delay = 0; delay < 6; delay++) await link.advance();
  expect((await first).value!.length).toBe(SOCKET_CHUNK_BYTES);
  expect(produced).toBe(SOCKET_WINDOW_CHUNKS);
  await reader.read();
  for (let delay = 0; delay < 6; delay++) await link.advance();
  expect(produced - 2).toBeLessThanOrEqual(SOCKET_WINDOW_CHUNKS);
  expect(produced).toBeGreaterThan(SOCKET_WINDOW_CHUNKS);
  await reader.cancel();
  await link.advance();
  expect(cancelled).toBe(true);
});

test("replacement upload credits crossing EOF do not close an otherwise active exchange", async () => {
  const admitted = Promise.withResolvers<Request>();
  const reply = Promise.withResolvers<Response>();
  const link = delayedLink(async (_path, incoming) => {
    admitted.resolve(incoming);
    return reply.promise;
  }, true);
  const source = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        controller.enqueue(new Uint8Array(SOCKET_CHUNK_BYTES * 2));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  let finished = false;
  const pending = link.client.request(
    "commands",
    request("commands", {
      method: "POST",
      body: source,
      duplex: "half",
    }),
  );
  await link.advance();
  const incoming = await admitted.promise;
  const reader = incoming.body!.getReader();
  const first = reader.read();
  await link.advance();
  await link.advance();
  expect((await first).value!.length).toBe(SOCKET_CHUNK_BYTES);
  expect((await reader.read()).value!.length).toBe(SOCKET_CHUNK_BYTES);
  // Producer has already ended, but its EOF is delayed on the return link.
  // Replacement credit from the second read arrives while response is pending.
  await link.advance();
  link.releaseEnds();
  await link.advance();
  expect(await reader.read()).toEqual({ done: true, value: undefined });
  reply.resolve(new Response(null, { status: 204 }));
  const result = pending.then((response) => {
    expect(response.status).toBe(204);
    finished = true;
  });
  for (let delay = 0; delay < 4 && !finished; delay++) await link.advance();
  expect(finished).toBe(true);
  await result;
});
