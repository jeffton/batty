import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { applyImmutable, type Op } from "@earendil-works/chord/delta";
import type { ConversationView } from "@earendil-works/pi-durable";
import { LiveDoc } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ServerEvent, SessionSnapshot, SessionState, WorkspaceInfo } from "@/shared/types";
import { createAgentSessionFixture } from "./agent-session-test-fixture";
import { PiService } from "./pi-service";
import { getSessionMessagePage } from "./pi-service-message-page";
import {
  attachSession,
  disposeWebSession,
  isWebSessionDisposing,
  documentOperations,
  publish,
  subscribeToSession,
} from "./pi-service-sessions";
import { handleSessionEvent } from "./pi-service-agent-events";
import type { WebSession } from "./pi-service-types";

const workspace: WorkspaceInfo = {
  id: "batty",
  label: "Batty",
  path: "/root/github/batty",
  kind: "workspace",
  isPinned: true,
  isAssistant: false,
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function snapshot(view: ConversationView): SessionSnapshot {
  return {
    metadata: {
      id: "session",
      sessionId: "session",
      workspaceId: workspace.id,
      cwd: workspace.path,
      thinkingLevel: "medium",
      availableThinkingLevels: ["medium"],
      updatedAt: 1,
      contextTokens: null,
      contextWindow: null,
      contextPercent: null,
      totalMessageCount: 0,
      hasMoreMessages: false,
    },
    documents: {
      "pi.live": view.docs["pi.live"] ?? {},
      "pi.inbox": view.docs["pi.inbox"] ?? { items: [] },
      "pi.agent": view.docs["pi.agent"] ?? {},
      "pi.usage": view.docs["pi.usage"] ?? { models: {}, tools: {} },
    } as SessionSnapshot["documents"],
    queuedClientMessageIds: {},
    messages: [],
    historyVersion: Math.max(0, ...view.entries.map((entry) => entry.id)),
  };
}

async function nativeSession() {
  const fixture = await createAgentSessionFixture();
  cleanups.push(fixture.cleanup);
  const sessions = new Map<string, WebSession>();
  const web = attachSession(sessions, vi.fn(), async () => {}, workspace, fixture.session);
  return { fixture, web };
}

function lifecycle(web: WebSession) {
  const state = {
    id: web.id,
    sessionId: web.id,
    workspaceId: workspace.id,
    isStreaming: false,
    pendingMessageCount: 0,
    messages: [],
    activeTools: [],
  } as unknown as SessionState;
  return {
    getState: vi.fn(() => state),
    notifyWorkspaceUpdated: vi.fn(async () => {}),
    disposeWebSession: vi.fn(),
    onAgentCompleted: vi.fn(async () => {}),
    onAgentSettled: vi.fn(async () => {}),
  };
}

describe("web session disposal ownership", () => {
  it("returns one cleanup promise and never deletes a replacement", async () => {
    let finishIdle!: () => void;
    let finishBrowser!: () => void;
    const idle = new Promise<void>((resolve) => {
      finishIdle = resolve;
    });
    const browser = new Promise<void>((resolve) => {
      finishBrowser = resolve;
    });
    const session = { waitForIdle: vi.fn(() => idle), dispose: vi.fn(async () => {}) };
    const old = { id: "child", session } as unknown as WebSession;
    const replacement = { id: "child" } as WebSession;
    const sessions = new Map([[old.id, old]]);
    const unregister = vi.fn();
    const closeBrowser = vi.fn(() => browser);
    const disposal = disposeWebSession(sessions, unregister, old, closeBrowser);
    expect(isWebSessionDisposing(old)).toBe(true);
    expect(disposeWebSession(sessions, unregister, old, closeBrowser)).toBe(disposal);
    finishIdle();
    await vi.waitFor(() => expect(session.dispose).toHaveBeenCalledOnce());
    expect(sessions.get(old.id)).toBe(old);
    sessions.set(old.id, replacement);
    finishBrowser();
    await disposal;
    expect(sessions.get(old.id)).toBe(replacement);
    expect(unregister).not.toHaveBeenCalled();
  });

  it("logs cleanup failure while retaining the rejection", async () => {
    const error = new Error("resource cleanup failed");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const web = {
      id: "child",
      session: {
        waitForIdle: async () => {},
        dispose: async () => {
          throw error;
        },
      },
    } as unknown as WebSession;
    const sessions = new Map([[web.id, web]]);
    await expect(disposeWebSession(sessions, vi.fn(), web)).rejects.toBe(error);
    expect(log).toHaveBeenCalledWith("Failed to close Pi harness", error);
    expect(sessions.get(web.id)).toBe(web);
    log.mockRestore();
  });
});

describe("native session document transport", () => {
  it("returns the requested history version rather than a later native frame version", async () => {
    const { fixture, web } = await nativeSession();
    const bound = Number(
      await fixture.session.sessionManager.appendMessage({
        role: "user",
        content: "captured",
        timestamp: 1,
      }),
    );
    await fixture.session.sessionManager.appendMessage({
      role: "user",
      content: "future",
      timestamp: 2,
    });
    const service = {
      requireSession: () => web,
      getMessagePage: (_web: WebSession, options: Parameters<typeof getSessionMessagePage>[1]) =>
        getSessionMessagePage(fixture.session, options),
    } as unknown as PiService;
    const page = PiService.prototype.getSessionMessages.call(service, web.id, {
      throughEntryId: bound,
    });
    expect(page.historyVersion).toBe(bound);
    expect(page.totalMessageCount).toBe(1);
    expect(page.messages).toMatchObject([
      { role: "user", blocks: [{ type: "text", text: "captured" }] },
    ]);
  });

  it("bounds full-history DTOs to the captured view rather than the current cache", async () => {
    const { fixture, web } = await nativeSession();
    await fixture.session.sessionManager.appendMessage({
      role: "user",
      content: "before",
      timestamp: 1,
    });
    const captured = fixture.session.view;
    await fixture.session.sessionManager.appendMessage({
      role: "user",
      content: "later",
      timestamp: 2,
    });
    const service = {
      requireSession: () => web,
      modelRuntime: fixture.modelRuntime,
      getMessagePage: (_web: WebSession, options: Parameters<typeof getSessionMessagePage>[1]) =>
        getSessionMessagePage(fixture.session, options),
    } as unknown as PiService;
    const frame = PiService.prototype.getSnapshot.call(service, web.id, captured);
    expect(frame.messages).toHaveLength(1);
    expect(frame.messages[0]).toMatchObject({
      role: "user",
      blocks: [{ type: "text", text: "before" }],
    });
    expect(frame.historyVersion).toBeLessThan(
      Math.max(...fixture.session.view.entries.map((entry) => entry.id)),
    );
    expect(frame.metadata).not.toHaveProperty("isStreaming");
    expect(frame.metadata).not.toHaveProperty("activeAssistant");
  });

  it("does not create a second assistant or tool authority when attaching", async () => {
    const { web } = await nativeSession();
    expect(web).not.toHaveProperty("activeAssistant");
    expect(web).not.toHaveProperty("activeTools");
    expect(web).not.toHaveProperty("eventLog");
    expect(web).not.toHaveProperty("streamId");
  });

  it("strips only the docs prefix and ignores raw transcript operations", () => {
    const documents = snapshot({ entries: [], docs: {} } as unknown as ConversationView).documents;
    const ops: Op[] = [
      ["a", ["docs", "pi.live", "tools", 0, "output"], "next"],
      ["t", ["docs", "pi.live", "tools", 0, "output"], 4],
      ["s", ["docs", "pi.live", "tools", 0, "details"], { nestedCalls: { calls: [] } }],
      ["p", ["entries"], 0, 0, []],
    ];
    expect(documentOperations(ops, documents)).toEqual([
      ["a", ["pi.live", "tools", 0, "output"], "next"],
      ["t", ["pi.live", "tools", 0, "output"], 4],
      ["s", ["pi.live", "tools", 0, "details"], { nestedCalls: { calls: [] } }],
    ]);
  });

  it("turns native overflow/root replacement into a documents-only base", () => {
    const documents = snapshot({ entries: [], docs: {} } as unknown as ConversationView).documents;
    expect(
      documentOperations([["r", { entries: [{ raw: "secret" }], docs: {} }]], documents),
    ).toEqual([["r", documents]]);
    expect(documentOperations([["s", ["docs"], {}]], documents)).toEqual([["r", documents]]);
  });

  it("starts every connection from a fresh base and applies native progress ops", async () => {
    const { fixture, web } = await nativeSession();
    const events: ServerEvent[] = [];
    const unsubscribe = await subscribeToSession(
      () => web,
      (_id, view) => snapshot(view),
      vi.fn(),
      web.id,
      (event) => events.push(event),
    );
    expect(events[0]?.type).toBe("session");
    const initial = events[0] as Extract<ServerEvent, { type: "session" }>;
    let documents = initial.snapshot.documents;
    await fixture.session.sessionManager.conversation.commit(async (tx) => {
      (await tx.doc(LiveDoc, fixture.session.sessionManager.conversation.id)).tools = [
        { callId: "call", name: "bash", status: "running", output: "first" },
      ];
    }, BACKGROUND_CONTEXT);
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(1));
    for (const event of events.slice(1)) {
      if (event.type === "session-update") {
        documents = applyImmutable(documents, event.documents);
        expect(event).not.toHaveProperty("messages");
      }
    }
    expect(documents["pi.live"].tools?.[0]?.output).toBe("first");
    unsubscribe();
    const reconnect = vi.fn();
    const stopReconnect = await subscribeToSession(
      () => web,
      (_id, view) => snapshot(view),
      vi.fn(),
      web.id,
      reconnect,
    );
    expect(reconnect).toHaveBeenCalledOnce();
    expect(reconnect.mock.calls[0]![0]).toMatchObject({
      type: "session",
      snapshot: { documents: { "pi.live": { tools: [{ output: "first" }] } } },
    });
    stopReconnect();
  });

  it("sends history only when the captured native entry boundary changes", async () => {
    const { fixture, web } = await nativeSession();
    const events: ServerEvent[] = [];
    const stop = await subscribeToSession(
      () => web,
      (_id, view) => snapshot(view),
      vi.fn(),
      web.id,
      (event) => events.push(event),
    );
    await fixture.session.sessionManager.appendCustomEntry("receipt", { complete: true });
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === "session-update" && "messages" in event)).toBe(
        true,
      ),
    );
    const update = events.find((event) => event.type === "session-update" && "messages" in event)!;
    expect(update).toMatchObject({ messages: [], historyVersion: expect.any(Number) });
    const beforeRefresh = events.length;
    publish(web);
    expect(events.length).toBe(beforeRefresh + 1);
    expect(events.at(-1)).toMatchObject({ type: "session-update", documents: [] });
    expect(events.at(-1)).not.toHaveProperty("messages");
    stop();
  });

  it("unsubscribes idempotently without browser-driven completion", async () => {
    const { web } = await nativeSession();
    const dispose = vi.fn();
    const stop = await subscribeToSession(
      () => web,
      (_id, view) => snapshot(view),
      dispose,
      web.id,
      vi.fn(),
    );
    expect(web.subscribers.size).toBe(1);
    stop();
    stop();
    expect(web.subscribers.size).toBe(0);
    expect(dispose).not.toHaveBeenCalled();
  });
});

describe("receipt-aware host completion", () => {
  it("notifies activity at native run start", async () => {
    const { web } = await nativeSession();
    web.agentCompleted = true;
    const deps = lifecycle(web);
    await handleSessionEvent(deps, web, { type: "run_start", inputs: [] });
    expect(web.agentCompleted).toBe(false);
    expect(deps.notifyWorkspaceUpdated).toHaveBeenCalledWith(workspace.id);
    expect(deps.onAgentCompleted).not.toHaveBeenCalled();
  });

  it("does not complete on native run end or tool/compaction events", async () => {
    const { web } = await nativeSession();
    const deps = lifecycle(web);
    await handleSessionEvent(deps, web, { type: "run_end", inputs: [] });
    expect(deps.onAgentCompleted).not.toHaveBeenCalled();
    expect(deps.disposeWebSession).not.toHaveBeenCalled();
  });

  it("runs receipt delivery before completion and disposes ephemeral children last", async () => {
    const { web } = await nativeSession();
    web.ephemeral = true;
    const deps = lifecycle(web);
    const order: string[] = [];
    deps.onAgentSettled.mockImplementation(async () => {
      order.push("receipts");
    });
    deps.notifyWorkspaceUpdated.mockImplementation(async () => {
      order.push("workspace");
    });
    deps.onAgentCompleted.mockImplementation(async () => {
      order.push("completed");
    });
    deps.disposeWebSession.mockImplementation(() => {
      order.push("dispose");
    });
    await handleSessionEvent(deps, web, { type: "agent_settled" });
    await handleSessionEvent(deps, web, { type: "agent_settled" });
    expect(order).toEqual(["receipts", "workspace", "completed", "dispose"]);
  });

  it("publishes workspace idle before a slow completion hook finishes", async () => {
    const { web } = await nativeSession();
    const deps = lifecycle(web);
    let finish!: () => void;
    deps.onAgentCompleted.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const work = handleSessionEvent(deps, web, { type: "agent_settled" });
    await vi.waitFor(() => expect(deps.onAgentCompleted).toHaveBeenCalledOnce());
    expect(deps.notifyWorkspaceUpdated).toHaveBeenCalledOnce();
    finish();
    await work;
  });
});
