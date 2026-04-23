import { describe, expect, it, vi } from "vite-plus/test";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { SessionState, WorkspaceInfo } from "@/shared/types";
import { handleAgentEvent } from "./pi-service-sessions";
import type { WebSession } from "./pi-service-types";

const workspace: WorkspaceInfo = {
  id: "batty",
  label: "Batty",
  path: "/root/github/batty",
  kind: "workspace",
  isPinned: true,
  isAssistant: false,
};

function createState(
  partial: Partial<SessionState>,
  webSession: WebSession,
  messages: SessionState["messages"],
): SessionState {
  return {
    id: webSession.id,
    sessionId: webSession.session.sessionId,
    workspaceId: workspace.id,
    cwd: workspace.path,
    thinkingLevel: "medium",
    availableThinkingLevels: ["medium"],
    isStreaming: true,
    pendingMessageCount: 0,
    updatedAt: 1,
    contextTokens: null,
    contextWindow: null,
    contextPercent: null,
    totalMessageCount: messages.length,
    hasMoreMessages: false,
    messages,
    activeAssistant: webSession.activeAssistant as
      | Extract<SessionState["messages"][number], { role: "assistant" }>
      | undefined,
    activeTools: [],
    ...partial,
  };
}

describe("handleAgentEvent", () => {
  it("keeps a tool-call assistant active when message_end arrives before the message is persisted", async () => {
    const published: Array<{ type: string; state?: SessionState }> = [];
    const assistantMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "Checking that" },
        { type: "toolCall", id: "call-1", name: "subagent", arguments: { prompt: "Search" } },
      ],
      timestamp: 1,
    };
    const webSession = {
      id: "web-1",
      workspace,
      session: { sessionId: "session-1" },
      subscribers: new Set(),
      activeAssistant: assistantMessage,
      activeTools: new Map(),
      openedAt: 1,
      ephemeral: false,
    } as unknown as WebSession;

    await handleAgentEvent(
      {
        getState: () => createState({}, webSession, []),
        getStateMetadata: () => createState({}, webSession, []),
        publish: (_webSession, event) =>
          published.push(event as { type: string; state?: SessionState }),
        notifyWorkspaceUpdated: async () => {},
        disposeWebSession: () => {},
      },
      webSession,
      { type: "message_end", message: assistantMessage } as unknown as AgentSessionEvent,
    );

    expect(webSession.activeAssistant).toEqual(assistantMessage);
    expect(published).toHaveLength(1);
    expect(published[0]?.type).toBe("reset");
    expect(published[0]?.state?.activeAssistant).toEqual(assistantMessage);
  });

  it("clears a tool-call assistant once the persisted message is present", async () => {
    const published: Array<{ type: string; state?: SessionState }> = [];
    const assistantMessage = {
      role: "assistant",
      content: [
        { type: "toolCall", id: "call-1", name: "subagent", arguments: { prompt: "Search" } },
      ],
      timestamp: 1,
    };
    const webSession = {
      id: "web-1",
      workspace,
      session: { sessionId: "session-1" },
      subscribers: new Set(),
      activeAssistant: assistantMessage,
      activeTools: new Map(),
      openedAt: 1,
      ephemeral: false,
    } as unknown as WebSession;
    const persistedMessages: SessionState["messages"] = [
      {
        id: "assistant-1",
        role: "assistant",
        timestamp: 1,
        blocks: [
          { type: "toolCall", id: "call-1", name: "subagent", arguments: { prompt: "Search" } },
        ],
      },
    ];

    await handleAgentEvent(
      {
        getState: () => createState({}, webSession, persistedMessages),
        getStateMetadata: vi.fn(),
        publish: (_webSession, event) =>
          published.push(event as { type: string; state?: SessionState }),
        notifyWorkspaceUpdated: async () => {},
        disposeWebSession: () => {},
      },
      webSession,
      { type: "message_end", message: assistantMessage } as unknown as AgentSessionEvent,
    );

    expect(webSession.activeAssistant).toBeUndefined();
    expect(published).toHaveLength(1);
    expect(published[0]?.type).toBe("reset");
    expect(published[0]?.state?.activeAssistant).toBeUndefined();
  });

  it("waits a microtask before publishing a user message reset", async () => {
    const published: Array<{ type: string; state?: SessionState }> = [];
    const userMessage = {
      role: "user",
      content: "hello",
      timestamp: 1,
    };
    const webSession = {
      id: "web-1",
      workspace,
      session: { sessionId: "session-1" },
      subscribers: new Set(),
      activeAssistant: undefined,
      activeTools: new Map(),
      openedAt: 1,
      ephemeral: false,
    } as unknown as WebSession;
    const persistedMessages: SessionState["messages"] = [
      {
        id: "user-1",
        role: "user",
        timestamp: 1,
        blocks: [{ type: "text", text: "hello" }],
      },
    ];
    let flushComplete = false;

    queueMicrotask(() => {
      flushComplete = true;
    });

    await handleAgentEvent(
      {
        getState: () => createState({}, webSession, flushComplete ? persistedMessages : []),
        getStateMetadata: vi.fn(),
        publish: (_webSession, event) =>
          published.push(event as { type: string; state?: SessionState }),
        notifyWorkspaceUpdated: async () => {},
        disposeWebSession: () => {},
      },
      webSession,
      { type: "message_end", message: userMessage } as unknown as AgentSessionEvent,
    );

    expect(published).toHaveLength(1);
    expect(published[0]?.type).toBe("reset");
    expect(published[0]?.state?.messages).toEqual(persistedMessages);
  });

  it("runs completion hooks on agent_end even when state still reports streaming", async () => {
    const onAgentCompleted = vi.fn();
    const notifyWorkspaceUpdated = vi.fn(async () => undefined);
    const published: Array<{ type: string; state?: SessionState }> = [];
    const webSession = {
      id: "web-1",
      workspace,
      session: { sessionId: "session-1" },
      subscribers: new Set(),
      activeAssistant: undefined,
      activeTools: new Map(),
      openedAt: 1,
      ephemeral: false,
    } as unknown as WebSession;
    const state = createState({ isStreaming: true }, webSession, []);

    await handleAgentEvent(
      {
        getState: () => state,
        getStateMetadata: vi.fn(),
        publish: (_webSession, event) =>
          published.push(event as { type: string; state?: SessionState }),
        notifyWorkspaceUpdated,
        disposeWebSession: vi.fn(),
        onAgentCompleted,
      },
      webSession,
      { type: "agent_end", messages: [] } as unknown as AgentSessionEvent,
    );

    expect(onAgentCompleted).toHaveBeenCalledTimes(1);
    expect(notifyWorkspaceUpdated).toHaveBeenCalledTimes(1);
    expect(published.at(-1)).toMatchObject({
      type: "reset",
      state: expect.objectContaining({ isStreaming: false, activeAssistant: undefined }),
    });
    expect(onAgentCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ isStreaming: false, pendingMessageCount: 0 }),
    );
  });

  it("defers completion hooks until auto-retry has fully finished", async () => {
    const onAgentCompleted = vi.fn();
    const notifyWorkspaceUpdated = vi.fn(async () => undefined);
    const webSession = {
      id: "web-1",
      workspace,
      session: { sessionId: "session-1" },
      subscribers: new Set(),
      activeAssistant: undefined,
      activeTools: new Map(),
      openedAt: 1,
      ephemeral: false,
    } as unknown as WebSession;
    const completedState = createState({ isStreaming: false }, webSession, []);
    const retryingState = createState({ isStreaming: true }, webSession, []);

    await handleAgentEvent(
      {
        getState: () => retryingState,
        getStateMetadata: vi.fn(),
        publish: vi.fn(),
        notifyWorkspaceUpdated,
        disposeWebSession: vi.fn(),
        onAgentCompleted,
      },
      webSession,
      {
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 2000,
        errorMessage: "server overloaded",
      } as unknown as AgentSessionEvent,
    );

    await handleAgentEvent(
      {
        getState: () => retryingState,
        getStateMetadata: vi.fn(),
        publish: vi.fn(),
        notifyWorkspaceUpdated,
        disposeWebSession: vi.fn(),
        onAgentCompleted,
      },
      webSession,
      { type: "agent_end", messages: [] } as unknown as AgentSessionEvent,
    );

    expect(onAgentCompleted).not.toHaveBeenCalled();

    await handleAgentEvent(
      {
        getState: () => completedState,
        getStateMetadata: vi.fn(),
        publish: vi.fn(),
        notifyWorkspaceUpdated,
        disposeWebSession: vi.fn(),
        onAgentCompleted,
      },
      webSession,
      {
        type: "auto_retry_end",
        success: false,
        attempt: 3,
        finalError: "server overloaded",
      } as unknown as AgentSessionEvent,
    );

    expect(onAgentCompleted).toHaveBeenCalledTimes(1);
    expect(notifyWorkspaceUpdated).toHaveBeenCalledTimes(1);

    await handleAgentEvent(
      {
        getState: () => completedState,
        getStateMetadata: vi.fn(),
        publish: vi.fn(),
        notifyWorkspaceUpdated,
        disposeWebSession: vi.fn(),
        onAgentCompleted,
      },
      webSession,
      { type: "agent_end", messages: [] } as unknown as AgentSessionEvent,
    );

    expect(onAgentCompleted).toHaveBeenCalledTimes(1);
    expect(notifyWorkspaceUpdated).toHaveBeenCalledTimes(1);
  });
});
