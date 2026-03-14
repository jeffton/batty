import { describe, expect, it } from "vite-plus/test";
import { applyServerEvent } from "@/client/lib/session-events";
import type { SessionState } from "@/shared/types";

const baseState: SessionState = {
  id: "web-1",
  sessionId: "session-1",
  workspaceId: "pi-face",
  cwd: "/tmp/pi-face",
  model: "anthropic/claude-sonnet-4",
  modelLabel: "Claude Sonnet 4 · anthropic",
  thinkingLevel: "medium",
  isStreaming: true,
  pendingMessageCount: 0,
  contextTokens: 12345,
  contextWindow: 200000,
  contextPercent: 6.2,
  messages: [],
  activeTools: [],
};

describe("applyServerEvent", () => {
  it("replaces state snapshots", () => {
    const next = applyServerEvent(baseState, {
      type: "state",
      state: { ...baseState, pendingMessageCount: 2 },
    });
    expect(next?.pendingMessageCount).toBe(2);
  });

  it("updates the active assistant during streaming", () => {
    const next = applyServerEvent(baseState, {
      type: "assistant",
      assistant: {
        id: "assistant-1",
        role: "assistant",
        timestamp: 1,
        blocks: [{ type: "text", text: "hello from pi-face" }],
      },
    });
    expect(next?.activeAssistant?.blocks[0]).toEqual({ type: "text", text: "hello from pi-face" });
  });

  it("merges tool updates by tool call id", () => {
    const first = applyServerEvent(baseState, {
      type: "tools",
      tools: [
        {
          toolCallId: "call-1",
          toolName: "bash",
          args: { command: "ls" },
          blocks: [{ type: "text", text: "partial output" }],
          isError: false,
        },
      ],
    });
    const second = applyServerEvent(first, {
      type: "tools",
      tools: [
        {
          toolCallId: "call-1",
          toolName: "bash",
          args: { command: "ls" },
          blocks: [{ type: "text", text: "final output" }],
          isError: false,
        },
      ],
    });

    expect(second?.activeTools).toHaveLength(1);
    expect(second?.activeTools[0]?.blocks[0]).toEqual({ type: "text", text: "final output" });
  });
});
