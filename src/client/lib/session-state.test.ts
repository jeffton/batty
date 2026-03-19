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
      activeTools: [],
    });
    expect(normalized?.updatedAt).toBeTypeOf("number");
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
