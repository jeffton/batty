import { once } from "node:events";
import fastify from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import WebSocket from "ws";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { RpcChannel, RpcError, type RpcHandler } from "../shared/rpc-channel";
import { createAuthToken } from "./auth";
import { registerOwnerSocket } from "./owner-socket";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(handle: RpcHandler) {
  const app = fastify();
  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 0 } });
  const close = registerOwnerSocket(
    app,
    { authSecret: "test-secret", cookieName: "session" },
    handle,
  );
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  cleanups.push(async () => {
    close();
    await app.close();
  });
  return { origin, token: createAuthToken("test-secret", 60_000) };
}

async function connect(origin: string, headers: Record<string, string>) {
  const socket = new WebSocket(`${origin.replace("http:", "ws:")}/api/socket`, { headers });
  socket.on("error", () => {});
  cleanups.push(async () => {
    socket.terminate();
  });
  return new Promise<WebSocket>((resolve, reject) => {
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      socket.terminate();
      reject(new Error(`Handshake ${response.statusCode}`));
    });
  });
}

it("requires owner credentials and same origin before admitting native calls", async () => {
  const handler = vi.fn(async () => ({ value: true }));
  const { origin, token } = await fixture(handler);
  await expect(connect(origin, { origin })).rejects.toThrow("Handshake 401");
  await expect(
    connect(origin, { origin: "https://other.example", cookie: `session=${token}` }),
  ).rejects.toThrow("Handshake 403");
  await expect(connect(origin, { cookie: `session=${token}` })).rejects.toThrow("Handshake 403");
  expect(handler).not.toHaveBeenCalled();
});

it("dispatches calls and large object events without HTTP or SSE serialization", async () => {
  const event = { type: "reset", text: "x".repeat(100_000) };
  const handler = vi.fn<RpcHandler>(async (operation, input) => {
    if (operation !== "session.watch") throw new RpcError("FORBIDDEN", "Unknown operation");
    return {
      value: input,
      events: new ReadableStream({
        start(controller) {
          controller.enqueue(event);
          controller.close();
        },
      }),
    };
  });
  const { origin, token } = await fixture(handler);
  const socket = await connect(origin, { origin, cookie: `session=${token}` });
  const channel = new RpcChannel(socket);
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No HTTP dispatch permitted"));
  const reply = await channel.call("session.watch", { sessionId: "main", after: "42" });
  expect(reply.value).toEqual({ sessionId: "main", after: "42" });
  const reader = reply.events!.getReader();
  expect(await reader.read()).toEqual({ done: false, value: event });
  expect(await reader.read()).toEqual({ done: true, value: undefined });
  await expect(channel.call("node.command", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(globalThis.fetch).not.toHaveBeenCalled();
  channel.close();
  await channel.closed;
});

it("revalidates the captured owner cookie for each call on an established socket", async () => {
  const now = Date.now();
  const handler = vi.fn(async () => ({ value: "owner-value" }));
  const { origin, token } = await fixture(handler);
  const socket = await connect(origin, { origin, cookie: `session=${token}` });
  const channel = new RpcChannel(socket);
  expect((await channel.call("workspace.list", {})).value).toBe("owner-value");
  vi.spyOn(Date, "now").mockReturnValue(now + 120_000);
  await expect(channel.call("workspace.list", {})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  expect(handler).toHaveBeenCalledTimes(1);
  const closed = once(socket, "close");
  channel.close();
  await closed;
});
