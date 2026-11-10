// @vitest-environment node
import { expect, test, vi } from "vite-plus/test";
import { observeAppStatus } from "./app-status-stream";
import type { Runtime } from "./runtime";

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("main status streams replay build/auth state, share usage subscription and clean up", async () => {
  const send = vi.fn(async (_event: import("@/shared/types").ServerEvent) => {});
  const controller = new AbortController();
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
  const close = observeAppStatus(runtime, "new-build", send, controller.signal, vi.fn());
  await settle();
  const events = () => send.mock.calls.map(([event]) => event);
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
  controller.abort();
  close();
  expect(stopProvider).toHaveBeenCalledOnce();
  expect(stopMcp).toHaveBeenCalledOnce();
  expect(stopUsage).toHaveBeenCalledOnce();
  const count = send.mock.calls.length;
  usageChanged({ provider: "openai-codex", usage: { windows: [] } });
  await settle();
  expect(send).toHaveBeenCalledTimes(count);
});

test("native status replay waits for consumption and drops queued events on cancellation", async () => {
  const pending = Promise.withResolvers<void>();
  const send = vi.fn(() => pending.promise);
  const controller = new AbortController();
  const runtime = {
    providerAuth: { subscribeAttempts: () => vi.fn(), listAuthAttempts: () => [] },
    tools: { mcp: { subscribeAttempts: () => vi.fn(), listAuthAttempts: () => [] } },
    providerUsage: { subscribe: () => vi.fn() },
  } as unknown as Runtime;
  observeAppStatus(runtime, "build", send, controller.signal, vi.fn());
  await settle();
  expect(send).toHaveBeenCalledTimes(1);
  controller.abort();
  pending.resolve();
  await settle();
  expect(send).toHaveBeenCalledTimes(1);
});
