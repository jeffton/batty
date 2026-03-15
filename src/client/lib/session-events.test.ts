import { describe, expect, it } from "vite-plus/test";
import { applyServerEvent } from "@/client/lib/session-events";
import type { SessionState } from "@/shared/types";

const baseState: SessionState = {
  id: "web-1",
  sessionId: "session-1",
  workspaceId: "pi-face",
  cwd: "/tmp/pi-face",
  path: "/tmp/pi-face/.session.jsonl",
  model: "anthropic/claude-sonnet-4",
  modelLabel: "Claude Sonnet 4 · anthropic",
  thinkingLevel: "medium",
  availableThinkingLevels: ["off", "low", "medium", "high"],
  isStreaming: true,
  pendingMessageCount: 0,
  updatedAt: 100,
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

  it("retains cached tool output when a state snapshot arrives without active tools", () => {
    const previous: SessionState = {
      ...baseState,
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          timestamp: 1,
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
          blocks: [{ type: "text", text: "==> Building app" }],
          status: "running",
          isError: false,
        },
      ],
    };

    const next = applyServerEvent(previous, {
      type: "state",
      state: { ...previous, isStreaming: false, activeTools: [] },
    });

    expect(next?.activeTools).toEqual(previous.activeTools);
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
          status: "running",
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
          status: "success",
          isError: false,
        },
      ],
    });

    expect(second?.activeTools).toHaveLength(1);
    expect(second?.activeTools[0]?.blocks[0]).toEqual({ type: "text", text: "final output" });
  });
});
