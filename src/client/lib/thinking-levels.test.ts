import { describe, expect, it } from "vite-plus/test";
import { resolveThinkingOptions } from "@/client/lib/thinking-levels";
import type { SessionState } from "@/shared/types";

function session(overrides: Partial<SessionState>): SessionState {
  return {
    id: "web-1",
    sessionId: "session-1",
    workspaceId: "batty",
    cwd: "/tmp/batty",
    thinkingLevel: "off",
    availableThinkingLevels: [],
    isStreaming: false,
    pendingMessageCount: 0,
    updatedAt: 1,
    contextTokens: null,
    contextWindow: null,
    contextPercent: null,
    totalMessageCount: 0,
    hasMoreMessages: false,
    messages: [],
    activeTools: [],
    ...overrides,
  };
}

describe("resolveThinkingOptions", () => {
  it("uses server-provided thinking levels when available", () => {
    expect(
      resolveThinkingOptions(
        session({
          thinkingLevel: "medium",
          availableThinkingLevels: ["off", "minimal", "low", "medium", "high"],
        }),
      ),
    ).toEqual(["off", "minimal", "low", "medium", "high"]);
  });

  it("returns no options without server-provided levels", () => {
    expect(
      resolveThinkingOptions(
        session({
          thinkingLevel: "high",
          availableThinkingLevels: [],
        }),
      ),
    ).toEqual([]);
  });

  it("deduplicates explicit levels without inventing new ones", () => {
    expect(
      resolveThinkingOptions(
        session({
          thinkingLevel: "high",
          availableThinkingLevels: ["high", "xhigh", "high"],
        }),
      ),
    ).toEqual(["high", "xhigh"]);
  });
});
