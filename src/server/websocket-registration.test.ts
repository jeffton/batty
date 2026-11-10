import { once } from "node:events";
import type { Socket } from "node:net";
import fastify from "fastify";
import cookie from "@fastify/cookie";
import WebSocket from "ws";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { RPC_MAX_MESSAGE_BYTES, RpcChannel } from "../shared/rpc";
import { createAuthToken } from "./auth";
import type { BrowserService } from "./browser-service";
import type { Runtime } from "./runtime";
import { registerReverseRemoteRoutes } from "./routes/reverse-remotes";
import { registerCloudBrowserRoutes } from "./routes/cloud-browser";

vi.mock("./cloud-browser-stream", () => ({
  CloudBrowserStreams: class {
    async subscribe() {
      return () => {};
    }
    async close() {}
    scrolling() {}
  },
}));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(shared: boolean) {
  const app = fastify();
  await app.register(cookie);
  if (shared) {
    await registerReverseRemoteRoutes(
      app,
      {
        config: { authSecret: "test-secret", cookieName: "session" },
        remotes: { reverse: { start() {}, async close() {} } },
      } as unknown as Runtime,
      async (_operation, input) => ({ value: input }),
    );
  }
  const cloudScroll = vi.fn(async () => {});
  const close = await registerCloudBrowserRoutes(
    app,
    { cloudTarget: async () => ({}), cloudScroll } as unknown as BrowserService,
    "/",
  );
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  cleanups.push(async () => {
    await close();
    await app.close();
  });
  async function connect(path: string) {
    const socket = new WebSocket(`${origin.replace("http:", "ws:")}${path}`, {
      maxPayload: RPC_MAX_MESSAGE_BYTES,
      headers: {
        origin,
        cookie: `session=${createAuthToken("test-secret", 60_000)}`,
      },
    });
    cleanups.push(async () => {
      socket.terminate();
    });
    await once(socket, "open");
    return socket;
  }
  return { app, cloudScroll, connect };
}

it.each([false, true])(
  "enforces cloud's original 2048-byte receiver limit with shared RPC server=%s",
  async (shared) => {
    const { connect, cloudScroll } = await fixture(shared);
    const socket = await connect("/api/cloud-browser/id/socket");
    const command = JSON.stringify({
      action: "scroll",
      pageId: "p",
      revision: "r",
      x: 1,
      y: 2,
      deltaX: 0,
      deltaY: 3,
    });
    socket.send(command.padEnd(2048));
    await expect.poll(() => cloudScroll.mock.calls.length).toBe(1);
    const closed = once(socket, "close");
    socket.send(command.padEnd(2049));
    expect((await closed)[0]).toBe(1009);
    expect(cloudScroll).toHaveBeenCalledTimes(1);
  },
);

it("bounds the complete cloud message even when fragmented into smaller WebSocket frames", async () => {
  const { connect } = await fixture(true);
  const socket = await connect("/api/cloud-browser/id/socket");
  const closed = once(socket, "close");
  socket.send(" ".repeat(1024), { fin: false });
  socket.send(" ".repeat(1025), { fin: true });
  expect((await closed)[0]).toBe(1009);
});

it("retains large RPC JSON values alongside independently bounded browser controls", async () => {
  const { app, connect } = await fixture(true);
  expect(app.websocketServer.options.maxPayload).toBe(RPC_MAX_MESSAGE_BYTES);
  const socket = await connect("/api/socket");
  const channel = new RpcChannel(socket);
  const input = { text: "x".repeat(100_000) };
  expect((await channel.call("echo", input)).value).toEqual(input);
  channel.close();
});

it("rejects oversized RPC messages from their wire header before reading their payload", async () => {
  const { connect } = await fixture(true);
  const socket = await connect("/api/socket");
  const closed = once(socket, "close");
  // A masked, 64-bit-length JSON text message. Deliberately send only its header:
  // the receiver must reject the declared length without allocating the payload.
  const header = Buffer.alloc(14);
  header[0] = 0x81;
  header[1] = 0xff;
  header.writeBigUInt64BE(BigInt(RPC_MAX_MESSAGE_BYTES + 1), 2);
  (socket as WebSocket & { _socket: Socket })._socket.write(header);
  expect((await closed)[0]).toBe(1009);
});
