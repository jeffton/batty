import { describe, expect, it } from "vite-plus/test";
import { normalizeSessionState } from "@/client/lib/session-state";
import type { SessionState } from "@/shared/types";

describe("normalizeSessionState", () => {
  it("fills missing fields from legacy cached sessions", () => {
    const legacy = {
      id: "web-1",
      sessionId: "session-1",
      workspaceId: "pi-face",
      cwd: "/tmp/pi-face",
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
      workspaceId: "pi-face",
      cwd: "/tmp/pi-face",
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
});
