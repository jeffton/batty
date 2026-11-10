import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fastify from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import WebSocket from "ws";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { RpcChannel, RpcError, type RpcHandler } from "../shared/rpc";
import { createAuthToken } from "./auth";
import { registerOwnerSocket } from "./owner-socket";
import { registerAuthRoutes } from "./routes/auth";
import { loadConfig } from "./config";
import { PasskeyAuthService } from "./passkeys";
import { createLoginRateLimiter } from "./login-rate-limit";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(handle: RpcHandler, ttlMs = 60_000) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "batty-owner-socket-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, ".batty"));
  await writeFile(
    path.join(directory, ".batty", "options.json"),
    JSON.stringify({ workspacesRoots: [directory], webPushSubject: "mailto:test@example.com" }),
  );
  const config = {
    ...(await loadConfig(directory)),
    authSecret: "test-secret",
    cookieName: "session",
  };
  const app = fastify();
  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 0 } });
  const close = registerOwnerSocket(
    app,
    { authSecret: "test-secret", cookieName: "session" },
    handle,
  );
  registerAuthRoutes({
    app,
    config,
    passkeys: new PasskeyAuthService(directory, config.authSecret),
    authAttemptLimiter: createLoginRateLimiter(),
    routePath: (route: string) => route,
  });
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  cleanups.push(async () => {
    close();
    await app.close();
  });
  return { app, origin, token: createAuthToken("test-secret", ttlMs) };
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

it("closes an existing subscription at token expiry and cancels its event source", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const cancelled = vi.fn();
  const { origin, token } = await fixture(async () => ({
    value: null,
    events: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "ready" });
      },
      cancel: cancelled,
    }),
  }));
  const socket = await connect(origin, { origin, cookie: `session=${token}` });
  const channel = new RpcChannel(socket);
  const reply = await channel.call("session.watch", {});
  expect((await reply.events!.getReader().read()).value).toEqual({ type: "ready" });
  const closed = once(socket, "close");
  await vi.advanceTimersByTimeAsync(60_000);
  await closed;
  await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(1));
  await expect(connect(origin, { origin, cookie: `session=${token}` })).rejects.toThrow(
    "Handshake 401",
  );
});

it("schedules a 30-day cookie without overflowing Node's timer delay", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const { origin, token } = await fixture(async () => ({ value: true }), 30 * 24 * 60 * 60_000);
  const socket = await connect(origin, { origin, cookie: `session=${token}` });
  const channel = new RpcChannel(socket);
  await vi.advanceTimersByTimeAsync(2 ** 31 - 1);
  expect((await channel.call("workspace.list", {})).value).toBe(true);
  const closed = once(socket, "close");
  await vi.advanceTimersByTimeAsync(30 * 24 * 60 * 60_000 - (2 ** 31 - 1));
  await closed;
});

it("logout closes all channels for that cookie without affecting another signed-in session", async () => {
  const cancelled = vi.fn();
  const { app, origin, token } = await fixture(async () => ({
    value: null,
    events: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "ready" });
      },
      cancel: cancelled,
    }),
  }));
  const otherToken = createAuthToken("test-secret", 120_000);
  const sockets = await Promise.all([
    connect(origin, { origin, cookie: `session=${token}` }),
    connect(origin, { origin, cookie: `session=${token}` }),
    connect(origin, { origin, cookie: `session=${otherToken}` }),
  ]);
  const channels = sockets.map((socket) => new RpcChannel(socket));
  for (const channel of channels) {
    const reply = await channel.call("session.watch", {});
    await reply.events!.getReader().read();
  }
  const closed = sockets.slice(0, 2).map((socket) => once(socket, "close"));
  const logout = await app.inject({
    method: "POST",
    url: "/api/logout",
    headers: { cookie: `session=${token}` },
  });
  expect(logout.statusCode).toBe(200);
  expect(logout.headers["set-cookie"]).toContain("session=;");
  await Promise.all(closed);
  await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(2));
  expect(sockets[2]!.readyState).toBe(WebSocket.OPEN);
  // Cookies are stateless: logout closes live channels, not copied token replay.
  const replay = await connect(origin, { origin, cookie: `session=${token}` });
  replay.terminate();
  channels[2]!.close();
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
