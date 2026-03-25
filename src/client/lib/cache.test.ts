import { describe, expect, it } from "vite-plus/test";
import { reactive } from "vue";
import { cloneForCache, trimSessionForCache } from "@/client/lib/cache";
import type { SessionState } from "@/shared/types";

const state: SessionState = {
  id: "web-1",
  sessionId: "session-1",
  workspaceId: "batty",
  cwd: "/tmp/batty",
  path: "/tmp/batty/.session.jsonl",
  model: "anthropic/claude-sonnet-4",
  modelLabel: "Claude Sonnet 4 · anthropic",
  thinkingLevel: "medium",
  availableThinkingLevels: ["off", "low", "medium", "high"],
  isStreaming: true,
  pendingMessageCount: 1,
  updatedAt: 100,
  contextTokens: 12345,
  contextWindow: 200000,
  contextPercent: 6.2,
  totalMessageCount: 0,
  hasMoreMessages: false,
  messages: [],
  activeAssistant: {
    id: "assistant-1",
    role: "assistant",
    timestamp: 1,
    blocks: [{ type: "text", text: "streaming" }],
  },
  activeTools: [
    {
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "ls" },
      blocks: [{ type: "text", text: "partial" }],
      status: "running",
      isError: false,
    },
  ],
};

describe("cloneForCache", () => {
  it("converts reactive session state into a structured-cloneable value", () => {
    const reactiveState = reactive(state);

    expect(() => structuredClone(reactiveState)).toThrow();

    const cloned = cloneForCache(reactiveState);

    expect(structuredClone(cloned)).toEqual(cloned);
    expect(cloned).toEqual(state);
    expect(cloned).not.toBe(reactiveState);
  });
});

describe("trimSessionForCache", () => {
  it("keeps only the recent message window and preserves paging metadata", () => {
    const trimmed = trimSessionForCache({
      ...state,
      totalMessageCount: 120,
      messages: Array.from({ length: 80 }, (_, index) => ({
        id: `user-${index}`,
        role: "user" as const,
        timestamp: index,
        blocks: [{ type: "text" as const, text: String(index) }],
      })),
    });

    expect(trimmed.messages).toHaveLength(50);
    expect(trimmed.messages[0]?.id).toBe("user-30");
    expect(trimmed.totalMessageCount).toBe(120);
    expect(trimmed.hasMoreMessages).toBe(true);
  });
});
