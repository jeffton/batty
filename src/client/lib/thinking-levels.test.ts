import { describe, expect, it } from "vite-plus/test";
import { resolveThinkingOptions } from "@/client/lib/thinking-levels";
import type { ModelOption, SessionState } from "@/shared/types";

const reasoningModel: ModelOption = {
  id: "anthropic/claude-sonnet-4",
  label: "Claude Sonnet 4 · anthropic",
  provider: "anthropic",
  reasoning: true,
  supportsImages: true,
};

const nonReasoningModel: ModelOption = {
  id: "openai/gpt-4.1-mini",
  label: "GPT-4.1 Mini · openai",
  provider: "openai",
  reasoning: false,
  supportsImages: true,
};

function session(overrides: Partial<SessionState>): SessionState {
  return {
    id: "web-1",
    sessionId: "session-1",
    workspaceId: "pi-face",
    cwd: "/tmp/pi-face",
    thinkingLevel: "off",
    availableThinkingLevels: [],
    isStreaming: false,
    pendingMessageCount: 0,
    updatedAt: 1,
    contextTokens: null,
    contextWindow: null,
    contextPercent: null,
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
          model: reasoningModel.id,
          thinkingLevel: "medium",
          availableThinkingLevels: ["off", "minimal", "low", "medium", "high"],
        }),
        [reasoningModel],
      ),
    ).toEqual(["off", "minimal", "low", "medium", "high"]);
  });

  it("falls back to Pi's default reasoning levels for reasoning models", () => {
    expect(
      resolveThinkingOptions(
        session({
          model: reasoningModel.id,
          thinkingLevel: "high",
          availableThinkingLevels: [],
        }),
        [reasoningModel],
      ),
    ).toEqual(["off", "minimal", "low", "medium", "high"]);
  });

  it("treats single current-level caches as legacy fallbacks", () => {
    expect(
      resolveThinkingOptions(
        session({
          model: reasoningModel.id,
          thinkingLevel: "high",
          availableThinkingLevels: ["high"],
        }),
        [reasoningModel],
      ),
    ).toEqual(["off", "minimal", "low", "medium", "high"]);
  });

  it("keeps non-reasoning models on off", () => {
    expect(
      resolveThinkingOptions(
        session({
          model: nonReasoningModel.id,
          thinkingLevel: "off",
          availableThinkingLevels: [],
        }),
        [nonReasoningModel],
      ),
    ).toEqual(["off"]);
  });
});
