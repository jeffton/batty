import { describe, expect, it } from "vite-plus/test";
import { mergeSessionState, normalizeSessionState } from "@/client/lib/session-state";
import type { SessionState } from "@/shared/types";

describe("normalizeSessionState", () => {
  it("fills missing fields from legacy cached sessions", () => {
    const legacy = {
      id: "web-1",
      sessionId: "session-1",
      workspaceId: "batty",
      cwd: "/tmp/batty",
      thinkingLevel: "medium",
      messages: [
        {
          id: "user-1",
          role: "user",
          timestamp: 123,
          blocks: [{ type: "text", text: "hello" }],
        },
      ],
      activeTools: [],
    } as SessionState;

    expect(normalizeSessionState(legacy)).toEqual({
      ...legacy,
      path: undefined,
      model: undefined,
      modelLabel: undefined,
      thinkingLevel: "medium",
      availableThinkingLevels: ["medium"],
      isStreaming: false,
      pendingMessageCount: 0,
      updatedAt: 123,
      contextTokens: null,
      contextWindow: null,
      contextPercent: null,
      totalMessageCount: 1,
      hasMoreMessages: false,
      messages: legacy.messages,
      activeTools: [],
    });
  });

  it("normalizes invalid arrays and timestamps", () => {
    const normalized = normalizeSessionState({
      id: "web-1",
      sessionId: "session-1",
      workspaceId: "batty",
      cwd: "/tmp/batty",
      thinkingLevel: "",
      availableThinkingLevels: ["", "high", "high"] as unknown as string[],
      isStreaming: true,
      pendingMessageCount: Number.NaN,
      updatedAt: Number.NaN,
      contextTokens: Number.NaN,
      contextWindow: Number.NaN,
      contextPercent: Number.NaN,
      messages: [],
      activeTools: undefined as unknown as SessionState["activeTools"],
    } as SessionState);

    expect(normalized).toMatchObject({
      thinkingLevel: "off",
      availableThinkingLevels: ["high"],
      pendingMessageCount: 0,
      contextTokens: null,
      contextWindow: null,
      contextPercent: null,
      totalMessageCount: 0,
      hasMoreMessages: false,
      activeTools: [],
    });
    expect(normalized?.updatedAt).toBeTypeOf("number");
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
          timestamp: 201,
          blocks: [{ type: "text", text: "replacement" }],
        },
      ],
    } as unknown as SessionState;

    expect(mergeSessionState(incoming, previous)?.messages).toEqual(incoming.messages);
  });

  it("retains cached tool output when a refreshed session loses in-flight tools", () => {
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
});
