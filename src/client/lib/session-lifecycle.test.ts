import { afterEach, expect, test, vi } from "vite-plus/test";
import { createSessionConnection } from "./session-connection";
import { rpcCall, closeRpcTransport } from "./rpc";
import { prependHistoryPage } from "./session-pagination";
import { recentSessionWindow } from "./session-window";
import { applyServerEvent } from "./session-events";
import { sessionHistoryCursor } from "./session-stream";
import type { SessionState } from "@/shared/types";
import { RpcError } from "@/shared/rpc-channel";
import type { OwnerSessionEvent } from "@/shared/owner-api";
vi.mock("./rpc", () => ({ rpcCall: vi.fn(), closeRpcTransport: vi.fn() }));
const state = (ids: string[]): SessionState => ({
  id: "1",
  sessionId: "1",
  workspaceId: "roy",
  cwd: "/",
  thinkingLevel: "off",
  availableThinkingLevels: ["off"],
  isStreaming: false,
  pendingMessageCount: 0,
  updatedAt: 1,
  contextTokens: null,
  contextWindow: null,
  contextPercent: null,
  totalMessageCount: ids.length,
  hasMoreMessages: false,
  messages: ids.map((id) => ({
    id,
    role: "user",
    timestamp: Number(id),
    blocks: [{ type: "text", text: id }],
  })),
  activeTools: [],
});

const connections: ReturnType<typeof createSessionConnection>[] = [];
afterEach(() => {
  for (const connection of connections.splice(0)) connection.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});
const tick = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
async function fixture(stall = false) {
  vi.useFakeTimers();
  const sources: {
    input: unknown;
    send(event: OwnerSessionEvent): void;
    fail(): void;
    cancel: ReturnType<typeof vi.fn>;
  }[] = [];
  vi.mocked(rpcCall).mockImplementation(async (_operation, input, options) => {
    let active = true;
    let controller!: ReadableStreamDefaultController<unknown>;
    const cancel = vi.fn(() => {
      active = false;
    });
    const events = new ReadableStream<unknown>({
      start(value) {
        controller = value;
      },
      cancel,
    });
    options!.signal!.addEventListener("abort", cancel, { once: true });
    const current = {
      input,
      send(event: OwnerSessionEvent) {
        if (active) controller.enqueue(event);
      },
      fail() {
        if (active) controller.error(new Error("Disconnected"));
      },
      cancel,
    };
    sources.push(current);
    if (stall && sources.length === 1) return await new Promise<never>(() => {});
    return { value: undefined, events };
  });
  let cursor = "10";
  const onEvent = vi.fn();
  const onError = vi.fn();
  const connection = createSessionConnection({
    operation: "session.watch",
    input: () => ({ sessionId: "main", after: cursor }),
    onConnecting: vi.fn(),
    onError,
    onEvent,
  });
  connections.push(connection);
  connection.open();
  await tick();
  return {
    connection,
    sources,
    onEvent,
    onError,
    cursor: (value: string) => {
      cursor = value;
    },
  };
}
test("subscription auth failures leave transport-generation invalidation to rpcCall", async () => {
  vi.mocked(rpcCall).mockRejectedValueOnce(new RpcError("UNAUTHORIZED", "Old session expired"));
  const { onError } = await fixture();
  expect(onError).toHaveBeenCalledOnce();
  expect(closeRpcTransport).not.toHaveBeenCalled();
});

test("an idle session leaves the shared socket and unrelated calls intact without domain heartbeats", async () => {
  const { sources } = await fixture();
  await vi.advanceTimersByTimeAsync(120_000);
  window.dispatchEvent(new Event("pageshow"));
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("focus"));
  expect(sources).toHaveLength(1);
  expect(sources[0]!.cancel).not.toHaveBeenCalled();
  expect(closeRpcTransport).not.toHaveBeenCalled();
});
test("focus/resume recover a stale subscription and disposal removes listeners", async () => {
  const { connection, sources } = await fixture();
  window.dispatchEvent(new Event("focus"));
  document.dispatchEvent(new Event("resume"));
  expect(sources).toHaveLength(1);
  vi.setSystemTime(Date.now() + 60_000);
  vi.advanceTimersByTime(5000);
  await tick();
  window.dispatchEvent(new Event("focus"));
  document.dispatchEvent(new Event("resume"));
  expect(sources).toHaveLength(2);
  connection.close();
  window.dispatchEvent(new Event("focus"));
  document.dispatchEvent(new Event("resume"));
  expect(sources).toHaveLength(2);
});
test("buffered heartbeats cannot hide a suspended event loop", async () => {
  const { sources } = await fixture();
  vi.setSystemTime(Date.now() + 60_000);
  sources[0]!.send({ type: "heartbeat" });
  await tick();
  vi.advanceTimersByTime(5000);
  await tick();
  expect(sources).toHaveLength(2);
});
test("a backwards clock change cannot grant a stale connection a fresh lease", async () => {
  const { sources } = await fixture();
  vi.setSystemTime(Date.now() - 60_000);
  vi.advanceTimersByTime(5000);
  await tick();
  window.dispatchEvent(new Event("focus"));
  expect(sources).toHaveLength(2);
});
test("hidden wake ticks preserve suspension until foreground recovery", async () => {
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  const { sources } = await fixture();
  vi.setSystemTime(Date.now() + 60_000);
  sources[0]!.send({ type: "heartbeat" });
  await tick();
  vi.advanceTimersByTime(5000);
  expect(sources).toHaveLength(1);
  visibility.mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  await tick();
  window.dispatchEvent(new Event("focus"));
  expect(sources).toHaveLength(2);
});
test("a stalled opening is cancelled within one heartbeat interval", async () => {
  const { sources } = await fixture(true);
  vi.advanceTimersByTime(4999);
  expect(sources).toHaveLength(1);
  vi.advanceTimersByTime(1);
  await tick();
  expect(sources).toHaveLength(2);
  expect(sources[0]!.cancel).toHaveBeenCalledOnce();
});
test("reconnect uses the latest cursor and rejects late events from old subscriptions", async () => {
  const { connection, sources, onEvent, cursor } = await fixture();
  sources[0]!.send({ type: "error", message: "first" });
  await tick();
  expect(onEvent).toHaveBeenCalledOnce();
  cursor("11");
  sources[0]!.fail();
  await tick();
  await vi.advanceTimersByTimeAsync(2000);
  expect(sources[1]!.input).toEqual({ sessionId: "main", after: "11" });
  sources[0]!.send({ type: "error", message: "late" });
  await tick();
  expect(onEvent).toHaveBeenCalledOnce();
  connection.close();
  sources[1]!.fail();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(sources).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
});
test("offline stops retries; online opens once; ordinary disposal preserves the socket", async () => {
  const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  const { connection, sources } = await fixture();
  sources[0]!.fail();
  await tick();
  online.mockReturnValue(false);
  window.dispatchEvent(new Event("offline"));
  await vi.advanceTimersByTimeAsync(30_000);
  expect(sources).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
  expect(closeRpcTransport).toHaveBeenCalledOnce();
  online.mockReturnValue(true);
  window.dispatchEvent(new Event("online"));
  await tick();
  window.dispatchEvent(new Event("pageshow"));
  expect(sources).toHaveLength(2);
  connection.close();
  expect(closeRpcTransport).toHaveBeenCalledOnce();
  window.dispatchEvent(new Event("online"));
  expect(sources).toHaveLength(2);
});

test("invisible-entry cursor survives empty deltas, metadata updates and cache serialization", () => {
  const previous = { ...state(["1"]), streamId: "current", revision: 1, historyCursor: "1000" };
  const incoming = {
    ...previous,
    messages: [],
    historyAfter: "1000",
    historyCursor: "2000",
    revision: 2,
  };
  const caughtUp = applyServerEvent(previous, {
    type: "reset",
    state: incoming,
    streamId: "current",
    revision: 2,
  })!;
  const { messages: _messages, historyCursor: _cursor, ...metadata } = previous;
  const updated = applyServerEvent(caughtUp, {
    type: "state",
    state: metadata,
    streamId: "current",
    revision: 3,
  })!;
  expect(updated.messages.map((message) => message.id)).toEqual(["1"]);
  expect(sessionHistoryCursor(JSON.parse(JSON.stringify(updated)))).toBe("2000");
});

test("historical page never overwrites a changed session/boundary or newer SSE counts", () => {
  const requested = { ...state(["20", "21"]), hasMoreMessages: true, totalMessageCount: 100 };
  const page = {
    messages: state(["19", "20"]).messages,
    hasMoreMessages: true,
    totalMessageCount: 100,
  };
  const newer = {
    ...requested,
    messages: state(["20", "21", "22"]).messages,
    totalMessageCount: 101,
  };
  expect(prependHistoryPage(newer, requested, page)).toMatchObject({
    totalMessageCount: 101,
    messages: [{ id: "19" }, { id: "20" }, { id: "21" }, { id: "22" }],
  });
  const other = { ...newer, sessionId: "2" };
  expect(prependHistoryPage(other, requested, page)).toBe(other);
  const expanded = { ...newer, messages: state(["18", "20", "21"]).messages };
  expect(prependHistoryPage(expanded, requested, page)).toBe(expanded);
});

test("an unattended permanent chat retains a week/minimum tail without deleting archive navigation", () => {
  const old = state(Array.from({ length: 50_000 }, (_, i) => String(i + 1)));
  const windowed = recentSessionWindow(old, 10 * 24 * 60 * 60 * 1000)!;
  expect(windowed.messages).toHaveLength(25);
  expect(windowed.hasMoreMessages).toBe(true);
  expect(windowed.totalMessageCount).toBe(50_000);
  expect(windowed.messages.at(-1)?.id).toBe("50000");
  const page = {
    messages: old.messages.slice(49_950, 49_975),
    totalMessageCount: 50_000,
    hasMoreMessages: true,
  };
  expect(prependHistoryPage(windowed, windowed, page).messages).toHaveLength(50);
});
