import { describe, expect, it } from "vite-plus/test";
import { reactive } from "vue";
import { cloneForCache } from "@/client/lib/cache";
import type { SessionState } from "@/shared/types";

const state: SessionState = {
  id: "web-1",
  sessionId: "session-1",
  workspaceId: "pi-face",
  cwd: "/tmp/pi-face",
  model: "anthropic/claude-sonnet-4",
  modelLabel: "Claude Sonnet 4 · anthropic",
  thinkingLevel: "medium",
  isStreaming: true,
  pendingMessageCount: 1,
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
