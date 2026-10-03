import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { getSession, getSessionMessages } from "@/client/lib/api";
import { writeCachedSession } from "@/client/lib/cache";
import { useAppStore } from "@/client/stores/app";
import type { SessionSnapshot, SessionSummary } from "@/shared/types";

const { setWorkspaceAssistant } = vi.hoisted(() => ({
  setWorkspaceAssistant: vi.fn(),
}));

vi.mock("@/client/lib/api", () => ({
  abortSession: vi.fn(),
  completeOpenAIProviderAuth: vi.fn(),
  createOrOpenDailySession: vi.fn(),
  createSession: vi.fn(),
  createWorkspace: vi.fn(),
  deleteCronJob: vi.fn(),
  getBattyAgentsFile: vi.fn(),
  getBootstrap: vi.fn(),
  getProviderAuthStatus: vi.fn(),
  getSession: vi.fn(),
  getSessionMessages: vi.fn(),
  getVersion: vi.fn(async () => ({ buildId: "build-1" })),
  listWorkspaceCronJobs: vi.fn(),
  listWorkspaceCronRunLogs: vi.fn(),
  listWorkspaceCronRuns: vi.fn(),
  listWorkspaceSessions: vi.fn(async (): Promise<SessionSummary[]> => []),
  listWorkspaces: vi.fn(async () => []),
  logout: vi.fn(),
  markSessionRead: vi.fn(),
  openSession: vi.fn(),
  openSessionById: vi.fn(),
  removeQueuedPrompt: vi.fn(),
  sendPrompt: vi.fn(),
  setAppearance: vi.fn(),
  setBattyAgentsFile: vi.fn(),
  setBraveSearchApiKey: vi.fn(),
  setProviderApiKey: vi.fn(),
  setSessionModel: vi.fn(),
  setSessionThinkingLevel: vi.fn(),
  setWorkspaceAssistant,
  setWorkspacePinned: vi.fn(),
  startOpenAIProviderAuth: vi.fn(),
  updateCronJob: vi.fn(),
}));

vi.mock("@/client/lib/cache", () => ({
  readCachedBootstrap: vi.fn(),
  readCachedSession: vi.fn(async () => undefined),
  writeCachedBootstrap: vi.fn(),
  writeCachedSession: vi.fn(async () => undefined),
}));

vi.mock("@/client/lib/agent-notifications", () => ({
  primeAgentNotifications: vi.fn(async () => false),
}));

vi.mock("@/client/lib/push-notifications", () => ({
  syncPushSubscription: vi.fn(async () => undefined),
}));

class MockEventSource {
  static instances: MockEventSource[] = [];

  readonly url: string;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void | Promise<void>) | null = null;
  onerror: ((event: Event) => void | Promise<void>) | null = null;
  closed = false;

  constructor(url: string | URL) {
    this.url = String(url);
    MockEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

import { makeSnapshot } from "@/client/lib/session-test-fixture";

describe("native app session streams", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    MockEventSource.instances = [];
    vi.clearAllMocks();
    vi.stubGlobal("EventSource", MockEventSource);
  });

  it("discards callbacks from replaced sockets and hydrates a fresh base", async () => {
    const store = useAppStore();
    await store.selectSession(makeSnapshot("a"));
    const first = MockEventSource.instances[0]!;
    const callback = first.onmessage!;
    await store.selectSession(makeSnapshot("b"));
    const second = MockEventSource.instances[1]!;
    callback(
      new MessageEvent("message", {
        data: JSON.stringify({ type: "session", snapshot: makeSnapshot("a") }),
      }),
    );
    expect(store.activeSession?.sessionId).toBe("b");
    second.onopen?.(new Event("open"));
    const base = makeSnapshot("b");
    base.documents = { ...base.documents, "pi.live": { run: { taskId: 1 as never, inputs: [] } } };
    second.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify({ type: "session", snapshot: base }) }),
    );
    expect(store.activeSession?.isStreaming).toBe(true);
    expect(store.$state).not.toHaveProperty("activeSession");
    expect(vi.mocked(writeCachedSession).mock.calls.at(-1)?.[0]).toHaveProperty("documents");
    store.closeStream();
  });

  it("requires a new base after reconnect before accepting deltas", async () => {
    const store = useAppStore();
    await store.selectSession(makeSnapshot());
    const source = MockEventSource.instances[0]!;
    source.onopen?.(new Event("open"));
    const send = (event: unknown) =>
      source.onmessage?.(new MessageEvent("message", { data: JSON.stringify(event) }));
    const base = makeSnapshot();
    send({ type: "session", snapshot: base });
    source.onopen?.(new Event("open"));
    send({
      type: "session-update",
      metadata: base.metadata,
      historyVersion: 0,
      queuedClientMessageIds: {},
      documents: [["s", ["pi.live", "run"], { taskId: 1, inputs: [] }]],
    });
    expect(store.activeSession?.isStreaming).toBe(false);
    send({ type: "session", snapshot: base });
    expect(store.activeSession?.isStreaming).toBe(false);
    store.closeStream();
  });

  it("rejects old history pages after reconnect or newer committed history", async () => {
    const store = useAppStore();
    const base = makeSnapshot();
    base.metadata.hasMoreMessages = true;
    base.messages = [{ role: "user", id: "entry-10", timestamp: 1, blocks: [] }];
    await store.selectSession(base);
    const pending = deferred<Awaited<ReturnType<typeof getSessionMessages>>>();
    vi.mocked(getSessionMessages).mockReturnValueOnce(pending.promise);
    const loading = store.loadOlderMessages();
    store.activeSnapshot = { ...base, historyVersion: 12 };
    pending.resolve({
      messages: [{ role: "user", id: "entry-1", timestamp: 1, blocks: [] }],
      historyVersion: 10,
      hasMoreMessages: false,
      totalMessageCount: 2,
    });
    await loading;
    expect(store.activeSession?.messages).toHaveLength(1);
    store.closeStream();
  });

  it("does not cache live-only partials or queue image deltas", async () => {
    const store = useAppStore();
    const base = makeSnapshot();
    base.documents = { ...base.documents, "pi.live": { run: { taskId: 1 as never, inputs: [] } } };
    await store.selectSession(base);
    const source = MockEventSource.instances[0]!;
    const send = (event: unknown) =>
      source.onmessage?.(new MessageEvent("message", { data: JSON.stringify(event) }));
    source.onopen?.(new Event("open"));
    send({ type: "session", snapshot: base });
    vi.mocked(writeCachedSession).mockClear();
    for (let index = 0; index < 10; index++) {
      send({
        type: "session-update",
        metadata: { ...base.metadata, updatedAt: index + 2 },
        queuedClientMessageIds: { "42": "client" },
        historyVersion: 0,
        documents: [
          [
            "s",
            ["pi.inbox", "items"],
            [
              {
                id: 42,
                mode: "followUp",
                content: [{ type: "image", mimeType: "image/png", data: "pixels".repeat(1000) }],
              },
            ],
          ],
        ],
      });
    }
    expect(writeCachedSession).not.toHaveBeenCalled();
    send({
      type: "session-update",
      metadata: base.metadata,
      historyVersion: 0,
      queuedClientMessageIds: {},
      documents: [["d", ["pi.live", "run"]]],
    });
    expect(writeCachedSession).toHaveBeenCalledTimes(1);
    store.closeStream();
  });

  it("a stale HTTP snapshot cannot replace a newer live delta at the same history version", async () => {
    const store = useAppStore();
    const base = makeSnapshot();
    await store.selectSession(base);
    const source = MockEventSource.instances[0]!;
    const send = (event: unknown) =>
      source.onmessage?.(new MessageEvent("message", { data: JSON.stringify(event) }));
    source.onopen?.(new Event("open"));
    send({ type: "session", snapshot: base });
    const pending = deferred<SessionSnapshot>();
    vi.mocked(getSession).mockReturnValueOnce(pending.promise);
    const refresh = store.refreshActiveSession();
    send({
      type: "session-update",
      metadata: base.metadata,
      historyVersion: 0,
      queuedClientMessageIds: {},
      documents: [["s", ["pi.live", "run"], { taskId: 7, inputs: [] }]],
    });
    pending.resolve(base);
    await refresh;
    expect(store.activeSnapshot?.documents["pi.live"].run?.taskId).toBe(7);
    expect(store.activeSession?.isStreaming).toBe(true);
    store.closeStream();
  });

  it("discards ahead-of-SSE HTTP snapshots before applying pending append frames", async () => {
    const store = useAppStore();
    const base = makeSnapshot();
    base.documents = {
      ...base.documents,
      "pi.live": {
        run: { taskId: 1 as never, inputs: [] },
        generation: {
          attempt: 1,
          message: { timestamp: 1, content: [{ type: "text", text: "prefix" }] } as never,
        },
      },
    };
    await store.selectSession(base);
    const source = MockEventSource.instances[0]!;
    const send = (event: unknown) =>
      source.onmessage?.(new MessageEvent("message", { data: JSON.stringify(event) }));
    source.onopen?.(new Event("open"));
    send({ type: "session", snapshot: base });
    const future = makeSnapshot(undefined, {
      historyVersion: 8,
      messages: [
        {
          id: "answer-8",
          role: "assistant",
          timestamp: 2,
          turnPhase: "final",
          blocks: [{ type: "text", text: "prefix next" }],
        },
      ],
    });
    vi.mocked(getSession).mockResolvedValueOnce(future);
    await store.refreshActiveSession();
    expect(store.activeSession?.messages).toEqual([]);
    expect(store.activeSession?.activeAssistant?.blocks).toEqual([
      { type: "text", text: "prefix" },
    ]);
    send({
      type: "session-update",
      metadata: base.metadata,
      historyVersion: 0,
      queuedClientMessageIds: {},
      documents: [["a", ["pi.live", "generation", "message", "content", 0, "text"], " next"]],
    });
    expect(store.activeSession?.activeAssistant?.blocks).toEqual([
      { type: "text", text: "prefix next" },
    ]);
    expect(store.activeSession?.messages).toEqual([]);
    store.closeStream();
  });

  it("pins detail hydration to captured stream history and rejects future answers", async () => {
    const store = useAppStore();
    await store.selectSession(makeSnapshot());
    vi.mocked(getSessionMessages).mockResolvedValueOnce({
      historyVersion: 8,
      totalMessageCount: 1,
      hasMoreMessages: false,
      messages: [
        {
          id: "answer-8",
          role: "assistant",
          timestamp: 2,
          turnPhase: "final",
          blocks: [{ type: "text", text: "future answer" }],
        },
      ],
    });
    await store.enhanceSessionMessages(store.activeSession!);
    expect(getSessionMessages).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "web-session-a" }),
      { throughEntryId: 0, limit: 25 },
    );
    expect(store.activeSession?.messages).toEqual([]);
    expect(store.activeSnapshot?.historyVersion).toBe(0);
    store.closeStream();
  });

  it("detail loading preserves newer native documents", async () => {
    const store = useAppStore();
    await store.selectSession(makeSnapshot());
    const pending = deferred<Awaited<ReturnType<typeof getSessionMessages>>>();
    vi.mocked(getSessionMessages).mockReturnValueOnce(pending.promise);
    const loading = store.enhanceSessionMessages(store.activeSession!);
    const current = store.activeSnapshot!;
    store.activeSnapshot = {
      ...current,
      documents: { ...current.documents, "pi.live": { run: { taskId: 1 as never, inputs: [] } } },
    };
    pending.resolve({
      messages: [],
      historyVersion: 0,
      totalMessageCount: 0,
      hasMoreMessages: false,
    });
    await loading;
    expect(store.activeSession?.isStreaming).toBe(true);
    store.closeStream();
  });
});
