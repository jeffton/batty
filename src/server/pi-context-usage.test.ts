import { describe, expect, it } from "vite-plus/test";
import { getSessionContextUsage } from "./pi-context-usage";

function assistantMessage(
  timestamp: number,
  options: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    text?: string;
  } = {},
) {
  const {
    input = 0,
    output = 0,
    cacheRead = 0,
    cacheWrite = 0,
    totalTokens = input + output + cacheRead + cacheWrite,
    text = "done",
  } = options;

  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5",
    usage: {
      input,
      output,
      cacheRead,
      cacheWrite,
      totalTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  };
}

function userMessage(timestamp: number, text: string) {
  return {
    role: "user",
    content: text,
    timestamp,
  };
}

describe("getSessionContextUsage", () => {
  it("keeps earlier parent usage and adds trailing zero-usage cron-subagent messages", () => {
    const usage = getSessionContextUsage({
      model: { contextWindow: 1000 },
      messages: [
        assistantMessage(1, { input: 120, output: 30 }),
        userMessage(2, "run the cron subagent"),
        assistantMessage(3, { totalTokens: 0, text: "Delivered report" }),
      ],
      sessionManager: { getBranch: () => [] },
    } as any);

    expect(usage?.tokens).toBe(160);
    expect(usage?.contextWindow).toBe(1000);
    expect(usage?.percent).toBeCloseTo(16, 5);
  });

  it("returns unknown after compaction when there is no post-compaction non-zero assistant usage", () => {
    const usage = getSessionContextUsage({
      model: { contextWindow: 1000 },
      messages: [
        assistantMessage(1, { input: 120, output: 30 }),
        assistantMessage(3, { totalTokens: 0 }),
      ],
      sessionManager: {
        getBranch: () => [
          {
            type: "compaction",
            timestamp: new Date(2).toISOString(),
          },
        ],
      },
    } as any);

    expect(usage).toEqual({ tokens: null, contextWindow: 1000, percent: null });
  });

  it("estimates from messages when the session has no assistant usage yet", () => {
    const usage = getSessionContextUsage({
      model: { contextWindow: 1000 },
      messages: [userMessage(1, "hello world")],
      sessionManager: { getBranch: () => [] },
    } as any);

    expect(usage?.tokens).toBe(3);
    expect(usage?.percent).toBeCloseTo(0.3, 5);
  });
});
