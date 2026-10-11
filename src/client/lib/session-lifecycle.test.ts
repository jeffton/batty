import { afterEach, expect, test, vi } from "vite-plus/test";
import { createSessionConnection } from "./session-connection";
import { prependHistoryPage } from "./session-pagination";
import { recentSessionWindow } from "./session-window";
import { applyServerEvent } from "./session-events";
import { sessionHistoryCursor } from "./session-stream";
import type { SessionState } from "@/shared/types";

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
  vi.unstubAllGlobals();
});

function connectionFixture() {
  vi.useFakeTimers();
  const sources: FakeSource[] = [];
  class FakeSource {
    onopen?: () => void;
    onerror?: () => void;
    onmessage?: (event: { data: string }) => void;
    close = vi.fn();
    listeners = new Map<string, () => void>();
    addEventListener(name: string, listener: () => void) {
      this.listeners.set(name, listener);
    }
    constructor(public url: string) {
      sources.push(this);
    }
  }
  vi.stubGlobal("EventSource", FakeSource);
  const onEvent = vi.fn();
  const onError = vi.fn();
  const connection = createSessionConnection({
    path: () => "/events",
    onConnecting: vi.fn(),
    onOpen: vi.fn(),
    onError,
    onEvent,
  });
  connections.push(connection);
  connection.open();
  return { connection, sources, onEvent, onError };
}

test("foreground events preserve a live stream and replace a stale stream only once", () => {
  const { sources } = connectionFixture();
  for (let i = 0; i < 6; i += 1) {
    vi.advanceTimersByTime(5000);
    sources[0]!.listeners.get("heartbeat")!();
  }
  window.dispatchEvent(new Event("pageshow"));
  document.dispatchEvent(new Event("visibilitychange"));
  expect(sources).toHaveLength(1);
  // Timers are suspended in the background; resume checks the wall clock immediately.
  vi.setSystemTime(Date.now() + 15_000);
  window.dispatchEvent(new Event("pageshow"));
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("online"));
  expect(sources).toHaveLength(2);
  expect(sources[0]!.close).toHaveBeenCalledOnce();
});

test("background timers preserve the stream; foreground replaces it once when stale", () => {
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  const { sources } = connectionFixture();
  vi.advanceTimersByTime(60_000);
  expect(sources).toHaveLength(1);
  visibility.mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("pageshow"));
  expect(sources).toHaveLength(2);
});

test("silent streams are replaced after 15 seconds and opening alone grants no indefinite lease", () => {
  const { sources } = connectionFixture();
  sources[0]!.onopen!();
  vi.advanceTimersByTime(15_000);
  expect(sources).toHaveLength(2);
});

test("foreground recovery cancels retry and stale callbacks cannot restart the new stream", () => {
  const { sources, onEvent } = connectionFixture();
  sources[0]!.onerror!();
  expect(sources[0]!.close).toHaveBeenCalledOnce();
  window.dispatchEvent(new Event("pageshow"));
  expect(sources).toHaveLength(2);
  sources[1]!.onopen!();
  sources[0]!.onopen!();
  sources[0]!.onerror!();
  sources[0]!.onmessage!({ data: '{"type":"error","message":"late"}' });
  vi.advanceTimersByTime(2000);
  expect(sources).toHaveLength(2);
  expect(onEvent).not.toHaveBeenCalled();
});

test("offline stops retries; online resumes once; disposed streams stay closed", () => {
  const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  const { connection, sources } = connectionFixture();
  sources[0]!.onerror!();
  online.mockReturnValue(false);
  window.dispatchEvent(new Event("offline"));
  vi.advanceTimersByTime(30_000);
  window.dispatchEvent(new Event("pageshow"));
  expect(sources).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
  online.mockReturnValue(true);
  window.dispatchEvent(new Event("online"));
  window.dispatchEvent(new Event("pageshow"));
  expect(sources).toHaveLength(2);
  connection.close();
  window.dispatchEvent(new Event("online"));
  document.dispatchEvent(new Event("visibilitychange"));
  vi.advanceTimersByTime(30_000);
  expect(sources).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
});

test("main and worker streams reconnect at their latest cursor; closing rejects late events and cancels timers", async () => {
  vi.useFakeTimers();
  const sources: {
    url: string;
    onmessage?: (event: { data: string }) => void;
    onerror?: () => void;
    onopen?: () => void;
    close: ReturnType<typeof vi.fn>;
  }[] = [];
  vi.stubGlobal(
    "EventSource",
    class {
      onmessage?: (event: { data: string }) => void;
      onerror?: () => void;
      onopen?: () => void;
      close = vi.fn();
      addEventListener = vi.fn();
      constructor(public url: string) {
        sources.push(this);
      }
    },
  );
  let cursor = "10";
  const events = vi.fn();
  const connection = createSessionConnection({
    path: () => `/events?after=${cursor}`,
    onConnecting: vi.fn(),
    onError: vi.fn(),
    onEvent: events,
  });
  connection.open();
  sources[0]!.onmessage!({ data: '{"type":"error","message":"visible error"}' });
  expect(events).toHaveBeenCalledTimes(1);
  cursor = "11";
  sources[0]!.onerror!();
  await vi.advanceTimersByTimeAsync(2000);
  expect(sources[1]!.url).toBe("/events?after=11");
  expect(sources[0]!.close).toHaveBeenCalledOnce();
  sources[0]!.onmessage!({ data: '{"type":"error","message":"stale"}' });
  expect(events).toHaveBeenCalledTimes(1);
  connection.close();
  sources[1]!.onerror!();
  await vi.advanceTimersByTimeAsync(120000);
  expect(sources).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
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
