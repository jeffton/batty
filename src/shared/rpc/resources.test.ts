import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import WebSocket, { WebSocketServer } from "ws";
import { expect, test, vi } from "vite-plus/test";
import {
  RpcChannel,
  RPC_CHUNK_BYTES,
  RPC_MAX_MESSAGE_BYTES,
  RPC_WINDOW_CHUNKS,
  type ChannelSocket,
} from "./channel";
import { rpcRegistry } from "./registry";

function stalledSocket(node: boolean) {
  const listeners = new Map<string, (event: { data: unknown }) => void>();
  const writes: { data: string | Uint8Array<ArrayBuffer>; done?: (error?: Error) => void }[] = [];
  const socket: ChannelSocket & { bufferedAmount: number } = {
    binaryType: "arraybuffer",
    bufferedAmount: 0,
    ...(node ? { on() {} } : {}),
    send(data, done) {
      writes.push({ data, done });
      socket.bufferedAmount =
        typeof data === "string" ? new TextEncoder().encode(data).length : data.byteLength;
    },
    close() {},
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
  };
  return {
    socket,
    writes,
    receive(frame: unknown) {
      listeners.get("message")!({ data: JSON.stringify(frame) });
    },
    drain() {
      socket.bufferedAmount = 0;
      writes.at(-1)?.done?.();
    },
  };
}

for (const node of [true, false]) {
  test(`aggregate ${node ? "Node" : "browser"} socket drain gates multiplexed producers and releases on close`, async () => {
    const link = stalledSocket(node);
    let produced = 0;
    let cancelled = 0;
    const channel = new RpcChannel(link.socket, {
      handle: async () => ({
        value: null,
        body: new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              produced++;
              controller.enqueue(new Uint8Array(RPC_CHUNK_BYTES));
            },
            cancel() {
              cancelled++;
            },
          },
          { highWaterMark: 0 },
        ),
      }),
    });
    try {
      const ids = [crypto.randomUUID(), crypto.randomUUID()];
      for (const id of ids)
        link.receive({ type: "call", id, operation: "download", input: null, body: false });
      await setImmediate();
      expect(link.writes).toHaveLength(1);
      link.drain();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(link.writes).toHaveLength(2);
      link.drain();
      await new Promise((resolve) => setTimeout(resolve, 10));
      for (const id of ids)
        link.receive({ type: "credit", id, lane: "body", count: RPC_WINDOW_CHUNKS });
      await setImmediate();
      expect(link.writes).toHaveLength(3);
      // Even renewed valid credit on the stalled lane cannot drain the source.
      link.receive({ type: "credit", id: ids[0], lane: "body", count: 1 });
      await setImmediate();
      expect(link.writes).toHaveLength(3);
      expect(produced).toBe(2); // one staged chunk per producer, one total socket write
      channel.close();
      await channel.closed;
      await vi.waitFor(() => expect(cancelled).toBe(2));
      expect(Reflect.get(channel, "calls").size).toBe(0);
    } finally {
      channel.close();
    }
  });
}

test("cancelling a command queued behind socket drain never sends that command", async () => {
  const link = stalledSocket(true);
  const channel = new RpcChannel(link.socket);
  const abort = new AbortController();
  const first = expect(channel.call("first", null)).rejects.toMatchObject({ code: "OFFLINE" });
  await setImmediate();
  const second = expect(channel.call("second", null, { signal: abort.signal })).rejects.toThrow(
    "cancel queued",
  );
  abort.abort(new Error("cancel queued"));
  await second;
  link.drain();
  await setImmediate();
  expect(
    link.writes.map(({ data }) => typeof data === "string" && JSON.parse(data).operation),
  ).not.toContain("second");
  channel.close();
  await first;
});

test("unexpected uploads reject before side effects and release every call and input producer", async () => {
  const registry = rpcRegistry<{ read: null }, { read: string }>();
  let invoked = 0;
  registry.add("read", () => {
    invoked++;
    return "read";
  });
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    maxPayload: RPC_MAX_MESSAGE_BYTES,
  });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing listener");
  const accepted = new Promise<RpcChannel>((resolve) =>
    server.once("connection", (socket) =>
      resolve(
        new RpcChannel(socket, {
          handle: async (operation, input, context) => {
            if (operation === "unconsumed") return { value: null };
            return registry.operations.get(operation)!(input, context);
          },
        }),
      ),
    ),
  );
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`, {
    maxPayload: RPC_MAX_MESSAGE_BYTES,
  });
  await once(socket, "open");
  const client = new RpcChannel(socket);
  const remote = await accepted;
  let cancelled = 0;
  const sources: ReadableStream<Uint8Array>[] = [];
  try {
    for (const operation of ["read", "read", "unconsumed"]) {
      const body = new ReadableStream<Uint8Array>(
        {
          cancel() {
            cancelled++;
          },
        },
        { highWaterMark: 0 },
      );
      sources.push(body);
      await expect(client.call(operation, null, { body })).rejects.toMatchObject({
        code: "BAD_INPUT",
      });
    }
    expect(invoked).toBe(0);
    expect(cancelled).toBe(3);
    await vi.waitFor(() => expect(sources.every((source) => !source.locked)).toBe(true));
    expect(Reflect.get(client, "calls").size).toBe(0);
    expect(Reflect.get(remote, "calls").size).toBe(0);
    expect((await client.call("read", null)).value).toBe("read");
  } finally {
    client.close();
    remote.close();
    for (const peer of server.clients) peer.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("files larger than the JSON admission limit remain streamed without a total transfer cap", async () => {
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    maxPayload: RPC_MAX_MESSAGE_BYTES,
  });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing listener");
  const total = RPC_MAX_MESSAGE_BYTES + RPC_CHUNK_BYTES;
  const accepted = new Promise<RpcChannel>((resolve) =>
    server.once("connection", (socket) =>
      resolve(
        new RpcChannel(socket, {
          handle: async (_operation, _input, context) => {
            const reader = context.body!.getReader();
            let received = 0;
            try {
              while (true) {
                const part = await reader.read();
                if (part.done) break;
                received += part.value.length;
              }
            } finally {
              reader.releaseLock();
            }
            return { value: received };
          },
        }),
      ),
    ),
  );
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`, {
    maxPayload: RPC_MAX_MESSAGE_BYTES,
  });
  await once(socket, "open");
  const client = new RpcChannel(socket);
  const remote = await accepted;
  let sent = 0;
  try {
    const reply = await client.call("upload", null, {
      body: new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (sent === total) controller.close();
            else {
              sent += RPC_CHUNK_BYTES;
              controller.enqueue(new Uint8Array(RPC_CHUNK_BYTES));
            }
          },
        },
        { highWaterMark: 0 },
      ),
    });
    expect(reply.value).toBe(total);
  } finally {
    client.close();
    remote.close();
    for (const peer of server.clients) peer.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 30_000);
