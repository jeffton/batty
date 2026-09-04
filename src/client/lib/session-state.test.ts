import { describe, expect, it } from "vite-plus/test";
import { mergeSessionState, normalizeSessionState } from "@/client/lib/session-state";
import type { SessionState } from "@/shared/types";

describe("normalizeSessionState", () => {
  it("trusts summary pagination metadata when tool messages are omitted", () => {
    const summary = {
      id: "web-1",
      sessionId: "session-1",
      workspaceId: "batty",
      cwd: "/tmp/batty",
      thinkingLevel: "medium",
      availableThinkingLevels: ["medium"],
      isStreaming: false,
      pendingMessageCount: 0,
      updatedAt: 200,
      contextTokens: null,
      contextWindow: null,
      contextPercent: null,
      totalMessageCount: 2,
      hasMoreMessages: false,
      messagesDetailLevel: "summary",
      messages: [
        {
          id: "assistant-100-0",
          role: "assistant",
          turnPhase: "final",
          timestamp: 100,
          blocks: [{ type: "text", text: "done" }],
        },
      ],
      activeTools: [],
    } as SessionState;

    expect(normalizeSessionState(summary)?.hasMoreMessages).toBe(false);
    expect(
      normalizeSessionState({ ...summary, messagesDetailLevel: "full" })?.hasMoreMessages,
    ).toBe(true);
  });

  it("merges paginated snapshots into an already loaded history", () => {
    const previous = {
      id: "web-1",
      sessionId: "session-1",
      workspaceId: "batty",
      cwd: "/tmp/batty",
      thinkingLevel: "medium",
      availableThinkingLevels: ["medium"],
      isStreaming: false,
      pendingMessageCount: 0,
      updatedAt: 200,
      contextTokens: null,
      contextWindow: null,
      contextPercent: null,
      totalMessageCount: 5,
      hasMoreMessages: false,
      messages: [
        {
          id: "user-100-0",
          role: "user",
          timestamp: 100,
          blocks: [{ type: "text", text: "one" }],
        },
        {
          id: "assistant-101-1",
          role: "assistant",
          turnPhase: "final",
          timestamp: 101,
          blocks: [{ type: "text", text: "two" }],
        },
        {
          id: "user-102-2",
          role: "user",
          timestamp: 102,
          blocks: [{ type: "text", text: "three" }],
        },
        {
          id: "assistant-103-3",
          role: "assistant",
          turnPhase: "final",
          timestamp: 103,
          blocks: [{ type: "text", text: "four" }],
        },
      ],
      activeTools: [],
    } as unknown as SessionState;

    const incoming = {
      ...previous,
      updatedAt: 300,
      totalMessageCount: 5,
      hasMoreMessages: true,
      messages: [
        previous.messages[2],
        previous.messages[3],
        {
          id: "user-104-4",
          role: "user",
          timestamp: 104,
          blocks: [{ type: "text", text: "five" }],
        },
      ],
    } as unknown as SessionState;

    expect(mergeSessionState(incoming, previous)?.messages.map((message) => message.id)).toEqual([
      "user-100-0",
      "assistant-101-1",
      "user-102-2",
      "assistant-103-3",
      "user-104-4",
    ]);
  });

  it("replaces loaded history when a reset snapshot no longer overlaps", () => {
    const previous = {
      id: "web-1",
      sessionId: "session-1",
      workspaceId: "batty",
      cwd: "/tmp/batty",
      thinkingLevel: "medium",
      availableThinkingLevels: ["medium"],
      isStreaming: false,
      pendingMessageCount: 0,
      updatedAt: 200,
      contextTokens: null,
      contextWindow: null,
      contextPercent: null,
      totalMessageCount: 4,
      hasMoreMessages: false,
      messages: [
        {
          id: "user-100-0",
          role: "user",
          timestamp: 100,
          blocks: [{ type: "text", text: "one" }],
        },
        {
          id: "assistant-101-1",
          role: "assistant",
          turnPhase: "final",
          timestamp: 101,
          blocks: [{ type: "text", text: "two" }],
        },
      ],
      activeTools: [],
    } as unknown as SessionState;

    const incoming = {
      ...previous,
      updatedAt: 300,
      totalMessageCount: 2,
      hasMoreMessages: false,
      messages: [
        {
          id: "user-200-0",
          role: "user",
          timestamp: 200,
          blocks: [{ type: "text", text: "replacement" }],
        },
        {
          id: "assistant-201-1",
          role: "assistant",
          turnPhase: "final",
          timestamp: 201,
          blocks: [{ type: "text", text: "replacement" }],
        },
      ],
    } as unknown as SessionState;

    expect(mergeSessionState(incoming, previous)?.messages).toEqual(incoming.messages);
  });

  it("drops cached tool output when an idle refreshed session has no active tools", () => {
    const previous: SessionState = {
      id: "web-1",
      sessionId: "session-1",
      workspaceId: "batty",
      cwd: "/tmp/batty",
      thinkingLevel: "medium",
      availableThinkingLevels: ["medium"],
      isStreaming: true,
      pendingMessageCount: 0,
      updatedAt: 200,
      contextTokens: null,
      contextWindow: null,
      contextPercent: null,
      totalMessageCount: 1,
      hasMoreMessages: false,
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          turnPhase: "intermediate",
          timestamp: 100,
          blocks: [
            { type: "text", text: "Deploying" },
            {
              type: "toolCall",
              id: "call-1",
              name: "bash",
              arguments: { command: "sudo ./scripts/deploy.sh" },
            },
          ],
        },
      ],
      activeTools: [
        {
          toolCallId: "call-1",
          toolName: "bash",
          args: { command: "sudo ./scripts/deploy.sh" },
          blocks: [{ type: "text", text: "==> Building app\n==> Reloading services" }],
          status: "running",
          isError: false,
        },
      ],
    };

    const incoming: SessionState = {
      ...previous,
      isStreaming: false,
      updatedAt: 300,
      activeTools: [],
    };

    expect(mergeSessionState(incoming, previous)?.activeTools).toEqual([]);
  });

  it("retains cached tool output while a refreshed streaming session loses in-flight tools", () => {
    const previous: SessionState = {
      id: "web-1",
      sessionId: "session-1",
      workspaceId: "batty",
      cwd: "/tmp/batty",
      thinkingLevel: "medium",
      availableThinkingLevels: ["medium"],
      isStreaming: true,
      pendingMessageCount: 0,
      updatedAt: 200,
      contextTokens: null,
      contextWindow: null,
      contextPercent: null,
      totalMessageCount: 1,
      hasMoreMessages: false,
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          turnPhase: "intermediate",
          timestamp: 100,
          blocks: [
            {
              type: "toolCall",
              id: "call-1",
              name: "bash",
              arguments: { command: "sudo ./scripts/deploy.sh" },
            },
          ],
        },
      ],
      activeTools: [
        {
          toolCallId: "call-1",
          toolName: "bash",
          args: { command: "sudo ./scripts/deploy.sh" },
          blocks: [{ type: "text", text: "==> Reloading services" }],
          status: "running",
          isError: false,
        },
      ],
    };

    const incoming: SessionState = {
      ...previous,
      updatedAt: 300,
      activeTools: [],
    };

    expect(mergeSessionState(incoming, previous)?.activeTools).toEqual(previous.activeTools);
  });

  it("drops cached tool output once the final tool result exists", () => {
    const previous: SessionState = {
      id: "web-1",
      sessionId: "session-1",
      workspaceId: "batty",
      cwd: "/tmp/batty",
      thinkingLevel: "medium",
      availableThinkingLevels: ["medium"],
      isStreaming: true,
      pendingMessageCount: 0,
      updatedAt: 200,
      contextTokens: null,
      contextWindow: null,
      contextPercent: null,
      totalMessageCount: 1,
      hasMoreMessages: false,
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          turnPhase: "intermediate",
          timestamp: 100,
          blocks: [
            {
              type: "toolCall",
              id: "call-1",
              name: "bash",
              arguments: { command: "sudo ./scripts/deploy.sh" },
            },
          ],
        },
      ],
      activeTools: [
        {
          toolCallId: "call-1",
          toolName: "bash",
          args: { command: "sudo ./scripts/deploy.sh" },
          blocks: [{ type: "text", text: "==> Reloading services" }],
          status: "running",
          isError: false,
        },
      ],
    };

    const incoming: SessionState = {
      ...previous,
      isStreaming: false,
      updatedAt: 300,
      totalMessageCount: 2,
      activeTools: [],
      messages: [
        ...previous.messages,
        {
          id: "tool-1",
          role: "toolResult",
          timestamp: 250,
          toolCallId: "call-1",
          toolName: "bash",
          blocks: [{ type: "text", text: "Deployed successfully" }],
          isError: false,
        },
      ],
    };

    expect(mergeSessionState(incoming, previous)?.activeTools).toEqual([]);
  });

  it("retains detailed tool blocks while merging a summary reset", () => {
    const previous = {
      id: "web-1",
      sessionId: "session-1",
      workspaceId: "batty",
      cwd: "/tmp/batty",
      thinkingLevel: "medium",
      availableThinkingLevels: ["medium"],
      isStreaming: false,
      pendingMessageCount: 0,
      updatedAt: 200,
      contextTokens: null,
      contextWindow: null,
      contextPercent: null,
      totalMessageCount: 2,
      hasMoreMessages: false,
      messagesDetailLevel: "full",
      messages: [
        {
          id: "assistant-100-0",
          role: "assistant",
          turnPhase: "intermediate",
          timestamp: 100,
          blocks: [
            { type: "text", text: "Checking" },
            { type: "toolCall", id: "call-1", name: "read", arguments: { path: "file" } },
          ],
        },
        {
          id: "tool-101-1",
          role: "toolResult",
          timestamp: 101,
          toolCallId: "call-1",
          toolName: "read",
          blocks: [{ type: "text", text: "result" }],
          isError: false,
        },
      ],
      activeTools: [],
    } as SessionState;
    const incoming = {
      ...previous,
      revision: 2,
      messagesDetailLevel: "summary",
      messages: [
        {
          id: "assistant-100-0",
          role: "assistant",
          turnPhase: "intermediate",
          timestamp: 100,
          blocks: [
            { type: "text", text: "Checking complete" },
            { type: "toolCall", id: "call-1", name: "read", arguments: { path: "file" } },
          ],
        },
      ],
    } as SessionState;

    const merged = mergeSessionState(incoming, previous);

    expect(merged?.messagesDetailLevel).toBe("summary");
    expect(merged?.messages).toHaveLength(2);
    expect(merged?.messages[0]).toMatchObject({
      blocks: [
        { type: "text", text: "Checking complete" },
        { type: "toolCall", id: "call-1" },
      ],
    });
  });

  it("does not retain tool state from an older active assistant", () => {
    const previous = {
      id: "web-1",
      sessionId: "session-1",
      workspaceId: "batty",
      cwd: "/tmp/batty",
      thinkingLevel: "medium",
      availableThinkingLevels: ["medium"],
      isStreaming: true,
      pendingMessageCount: 0,
      updatedAt: 100,
      contextTokens: null,
      contextWindow: null,
      contextPercent: null,
      totalMessageCount: 0,
      hasMoreMessages: false,
      messagesDetailLevel: "full",
      messages: [],
      activeAssistant: {
        id: "assistant-old",
        role: "assistant",
        turnPhase: "intermediate",
        timestamp: 100,
        blocks: [{ type: "toolCall", id: "call-old", name: "bash", arguments: { command: "old" } }],
      },
      activeTools: [
        {
          toolCallId: "call-old",
          toolName: "bash",
          args: { command: "old" },
          blocks: [{ type: "text", text: "stale output" }],
          status: "running",
          isError: false,
        },
      ],
    } as SessionState;
    const incoming = {
      ...previous,
      revision: 2,
      updatedAt: 200,
      messagesDetailLevel: "summary",
      activeAssistant: {
        id: "assistant-new",
        role: "assistant",
        turnPhase: "final",
        timestamp: 200,
        blocks: [{ type: "text", text: "New response" }],
      },
      activeTools: [],
    } as SessionState;

    const merged = mergeSessionState(incoming, previous);

    expect(merged?.activeAssistant).toEqual(incoming.activeAssistant);
    expect(merged?.activeTools).toEqual([]);
  });
});
