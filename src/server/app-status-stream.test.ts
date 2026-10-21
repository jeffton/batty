// @vitest-environment node
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { expect, test, vi } from "vite-plus/test";
import { streamAppStatus } from "./app-status-stream";
import type { Runtime } from "./runtime";

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("main status streams replay build/auth state, share usage subscription and clean up", async () => {
  const socket = Object.assign(new EventEmitter(), {
    write: vi.fn((_data: string) => true),
    destroyed: false,
    writableEnded: false,
  });
  let providerChanged!: (attempt: object) => void;
  let mcpChanged!: (attempt: object) => void;
  let usageChanged!: (usage: object) => void;
  const stopProvider = vi.fn();
  const stopMcp = vi.fn();
  const stopUsage = vi.fn();
  const runtime = {
    providerAuth: {
      subscribeAttempts(callback: typeof providerChanged) {
        providerChanged = callback;
        return stopProvider;
      },
      listAuthAttempts: () => [{ attemptId: "provider", completed: true }],
    },
    tools: {
      mcp: {
        subscribeAttempts(callback: typeof mcpChanged) {
          mcpChanged = callback;
          return stopMcp;
        },
        listAuthAttempts: () => [{ attemptId: "mcp", serverName: "example", status: "pending" }],
      },
    },
    providerUsage: {
      subscribe(callback: typeof usageChanged) {
        usageChanged = callback;
        callback({ provider: "openai-codex", usage: { windows: [] } });
        return stopUsage;
      },
    },
  } as unknown as Runtime;
  const close = streamAppStatus(socket as unknown as ServerResponse, runtime, "new-build", vi.fn());
  await settle();
  const events = () => socket.write.mock.calls.map(([data]) => JSON.parse(String(data).slice(6)));
  expect(events()).toEqual([
    { type: "build", buildId: "new-build" },
    {
      type: "auth-attempts",
      provider: [{ attemptId: "provider", completed: true }],
      mcp: [{ attemptId: "mcp", serverName: "example", status: "pending" }],
    },
    { type: "provider-usage", update: { provider: "openai-codex", usage: { windows: [] } } },
  ]);
  providerChanged({ attemptId: "provider", completed: false, error: "expired" });
  mcpChanged({ attemptId: "mcp", serverName: "example", status: "completed" });
  usageChanged({ provider: "openai-codex", error: "Rate limited" });
  await settle();
  expect(
    events()
      .slice(3)
      .map((event) => event.type),
  ).toEqual(["provider-auth-attempt", "mcp-auth-attempt", "provider-usage"]);
  socket.emit("close");
  close();
  expect(stopProvider).toHaveBeenCalledOnce();
  expect(stopMcp).toHaveBeenCalledOnce();
  expect(stopUsage).toHaveBeenCalledOnce();
  const count = socket.write.mock.calls.length;
  usageChanged({ provider: "openai-codex", usage: { windows: [] } });
  await settle();
  expect(socket.write).toHaveBeenCalledTimes(count);
});

test("status replay respects backpressure and drops queued events after disconnect", async () => {
  const socket = Object.assign(new EventEmitter(), {
    write: vi.fn((_data: string) => false),
    destroyed: false,
    writableEnded: false,
  });
  const runtime = {
    providerAuth: { subscribeAttempts: () => vi.fn(), listAuthAttempts: () => [] },
    tools: { mcp: { subscribeAttempts: () => vi.fn(), listAuthAttempts: () => [] } },
    providerUsage: { subscribe: () => vi.fn() },
  } as unknown as Runtime;
  streamAppStatus(socket as unknown as ServerResponse, runtime, "build", vi.fn());
  await settle();
  expect(socket.write).toHaveBeenCalledTimes(1);
  socket.destroyed = true;
  socket.emit("close");
  await settle();
  expect(socket.write).toHaveBeenCalledTimes(1);
  expect(socket.listenerCount("drain")).toBe(0);
});
