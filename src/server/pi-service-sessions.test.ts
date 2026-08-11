import { describe, expect, it, vi } from "vite-plus/test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ServerEvent, SessionState, WorkspaceInfo } from "@/shared/types";
import {
  handleAgentEvent,
  publish,
  subscribeToSession,
  summarizeResetEvent,
} from "./pi-service-sessions";
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

describe("summary reset events", () => {
  it("keeps tool payloads out of reset snapshots", () => {
    const webSession = {
      id: "web-summary",
      workspace,
      session: { sessionId: "session-summary" },
    } as unknown as WebSession;
    const state = createState(
      {
        messagesDetailLevel: "full",
        activeTools: [
          {
            toolCallId: "call-1",
            toolName: "read",
            args: { path: "large" },
            blocks: [{ type: "text", text: "active output" }],
            status: "running",
            isError: false,
            details: { diff: "active diff" },
          },
        ],
      },
      webSession,
      [
        {
          id: "assistant-1-0",
          role: "assistant",
          timestamp: 1,
          blocks: [
            { type: "text", text: "Checking it." },
            { type: "toolCall", id: "call-1", name: "read", arguments: { path: "large" } },
          ],
        },
        {
          id: "tool-2-1",
          role: "toolResult",
          timestamp: 2,
          toolCallId: "call-1",
          toolName: "read",
          blocks: [{ type: "text", text: "large result" }],
          isError: false,
          details: { diff: "large diff" },
        },
      ],
    );

    const summarized = summarizeResetEvent({ type: "reset", state });

    expect(summarized.type).toBe("reset");
    expect(summarized.type === "reset" ? summarized.state.messagesDetailLevel : undefined).toBe(
      "summary",
    );
    expect(JSON.stringify(summarized)).not.toContain("large result");
    expect(JSON.stringify(summarized)).not.toContain("active output");
    expect(JSON.stringify(summarized)).not.toContain("toolCall");
  });
});

describe("session event replay", () => {
  it("skips the duplicate snapshot and replays only missed events", () => {
    const webSession = {
      id: "web-replay",
      workspace,
      session: { sessionId: "session-replay", isStreaming: false },
      subscribers: new Set(),
      activeTools: new Map(),
      openedAt: 1,
      ephemeral: false,
      revision: 0,
      eventLog: [],
    } as unknown as WebSession;
    const getState = vi.fn(() => createState({ isStreaming: false }, webSession, []));
    const currentEvents = vi.fn();

    const unsubscribeCurrent = subscribeToSession(
      () => webSession,
      getState,
      vi.fn(),
      webSession.id,
      currentEvents,
      0,
    );
    expect(currentEvents).not.toHaveBeenCalled();
    expect(getState).not.toHaveBeenCalled();

    publish(webSession, { type: "status", isStreaming: true, pendingMessageCount: 1 });
    expect(currentEvents).toHaveBeenCalledWith(
      expect.objectContaining({ type: "status", revision: 1 }),
      1,
    );
    unsubscribeCurrent();

    const replayed = vi.fn();
    subscribeToSession(() => webSession, getState, vi.fn(), webSession.id, replayed, 0);
    expect(replayed).toHaveBeenCalledTimes(1);
    expect(replayed).toHaveBeenCalledWith(
      expect.objectContaining({ type: "status", revision: 1 }),
      1,
    );
    expect(getState).not.toHaveBeenCalled();
  });

  it("keeps replayed tool snapshots immutable", () => {
    const tool = {
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "echo" },
      blocks: [{ type: "text" as const, text: "first" }],
      status: "running" as const,
      isError: false,
    };
    const webSession = {
      id: "web-tools",
      workspace,
      session: { sessionId: "session-tools", isStreaming: true },
      subscribers: new Set(),
      activeTools: new Map([[tool.toolCallId, tool]]),
      openedAt: 1,
      ephemeral: false,
      revision: 0,
      eventLog: [],
    } as unknown as WebSession;

    publish(webSession, { type: "tools", tools: [tool] });
    tool.blocks = [{ type: "text", text: "mutated" }];
    const replayed = vi.fn();
    subscribeToSession(() => webSession, vi.fn(), vi.fn(), webSession.id, replayed, 0);

    expect(replayed.mock.calls[0]?.[0]).toMatchObject({
      type: "tools",
      tools: [{ blocks: [{ type: "text", text: "first" }] }],
    });
  });
});

describe("handleAgentEvent", () => {
  it("publishes assistant text as deltas without rebuilding session state", async () => {
    const publishEvent = vi.fn();
    const getState = vi.fn();
    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      timestamp: 1,
    };
    const webSession = {
      id: "web-delta",
      workspace,
      session: { sessionId: "session-delta" },
      subscribers: new Set(),
      activeTools: new Map(),
      openedAt: 1,
      ephemeral: false,
    } as unknown as WebSession;

    await handleAgentEvent(
      {
        getState,
        getStateMetadata: vi.fn(),
        publish: publishEvent,
        notifyWorkspaceUpdated: vi.fn(async () => undefined),
        disposeWebSession: vi.fn(),
      },
      webSession,
      {
        type: "message_update",
        message: assistantMessage,
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "o",
          partial: assistantMessage,
        },
      } as unknown as AgentSessionEvent,
    );

    expect(publishEvent).toHaveBeenCalledWith(webSession, {
      type: "assistant-delta",
      contentIndex: 0,
      blockType: "text",
      delta: "o",
    });
    expect(getState).not.toHaveBeenCalled();
  });

  it("publishes append-only tool output as deltas", async () => {
    const publishEvent = vi.fn();
    const current = {
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "printf ab" },
      blocks: [{ type: "text" as const, text: "a" }],
      status: "running" as const,
      isError: false,
    };
    const webSession = {
      id: "web-tool-delta",
      workspace,
      session: { sessionId: "session-tool-delta" },
      subscribers: new Set(),
      activeTools: new Map([[current.toolCallId, current]]),
      openedAt: 1,
      ephemeral: false,
    } as unknown as WebSession;

    await handleAgentEvent(
      {
        getState: vi.fn(),
        getStateMetadata: vi.fn(),
        publish: publishEvent,
        notifyWorkspaceUpdated: vi.fn(async () => undefined),
        disposeWebSession: vi.fn(),
      },
      webSession,
      {
        type: "tool_execution_update",
        toolCallId: "call-1",
        toolName: "bash",
        args: current.args,
        partialResult: { content: [{ type: "text", text: "ab" }] },
      } as unknown as AgentSessionEvent,
    );

    expect(publishEvent).toHaveBeenCalledWith(webSession, {
      type: "tool-delta",
      toolCallId: "call-1",
      deltas: [{ contentIndex: 0, blockType: "text", delta: "b" }],
      details: undefined,
    });
  });

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

  it("keeps terminal state idle after later lifecycle events", async () => {
    const published: SessionState[] = [];
    const webSession = {
      id: "web-1",
      workspace,
      session: { sessionId: "session-1", isStreaming: true },
      subscribers: new Set(),
      activeAssistant: undefined,
      activeTools: new Map([
        [
          "tool-1",
          {
            toolCallId: "tool-1",
            toolName: "bash",
            args: {},
            blocks: [],
            status: "running",
            isError: false,
          },
        ],
      ]),
      openedAt: 1,
      ephemeral: false,
    } as unknown as WebSession;
    const deps = {
      getState: () =>
        createState(
          {
            isStreaming:
              !webSession.agentCompleted &&
              (webSession.session.isStreaming ||
                [...webSession.activeTools.values()].some((tool) => tool.status === "running")),
            activeTools: [...webSession.activeTools.values()],
          },
          webSession,
          [],
        ),
      getStateMetadata: vi.fn(),
      publish: (_webSession: WebSession, event: ServerEvent) => {
        if (event.type === "reset") published.push(event.state);
      },
      notifyWorkspaceUpdated: vi.fn(async () => undefined),
      disposeWebSession: vi.fn(),
    };

    await handleAgentEvent(deps, webSession, {
      type: "agent_end",
      messages: [],
    } as unknown as AgentSessionEvent);
    await handleAgentEvent(deps, webSession, {
      type: "turn_end",
      turn: [],
    } as unknown as AgentSessionEvent);

    expect(webSession.agentCompleted).toBe(true);
    expect(webSession.activeTools.size).toBe(0);
    expect(published).toHaveLength(2);
    expect(published).toEqual([
      expect.objectContaining({ isStreaming: false, activeTools: [] }),
      expect.objectContaining({ isStreaming: false, activeTools: [] }),
    ]);
  });

  it("defers completion hooks when agent_end announces a pending retry", async () => {
    const onAgentCompleted = vi.fn();
    const notifyWorkspaceUpdated = vi.fn(async () => undefined);
    const publish = vi.fn();
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
    const retryingState = createState({ isStreaming: true }, webSession, []);

    await handleAgentEvent(
      {
        getState: () => retryingState,
        getStateMetadata: vi.fn(),
        publish,
        notifyWorkspaceUpdated,
        disposeWebSession: vi.fn(),
        onAgentCompleted,
      },
      webSession,
      { type: "agent_end", messages: [], willRetry: true } as unknown as AgentSessionEvent,
    );

    expect(onAgentCompleted).not.toHaveBeenCalled();
    expect(notifyWorkspaceUpdated).not.toHaveBeenCalled();
    expect(webSession.autoRetryActive).toBe(true);
    expect(publish).toHaveBeenCalledWith(
      webSession,
      expect.objectContaining({
        type: "reset",
        state: expect.objectContaining({ isStreaming: true }),
      }),
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
    expect(webSession.agentCompleted).not.toBe(true);

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
    expect(webSession.agentCompleted).toBe(true);

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
