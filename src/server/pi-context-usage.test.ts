import { describe, expect, it } from "vite-plus/test";
import { getSessionContextUsage, getViewContextUsage } from "./pi-context-usage";
import type { ConversationView } from "@earendil-works/pi-durable";

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
  it("reads model-context messages once instead of rebuilding them during a backwards search", () => {
    let reads = 0;
    const usage = getSessionContextUsage({
      model: { contextWindow: 1000 },
      get messages() {
        reads++;
        return [assistantMessage(1, { input: 100 }), userMessage(2, "hello world")];
      },
      sessionManager: { getBranch: () => [] },
    } as any);
    expect(reads).toBe(1);
    expect(usage?.tokens).toBe(103);
  });

  it("calculates usage from a captured native frame rather than later history", () => {
    const view = {
      entries: [
        { id: 1, kind: "pi.assistant", model: [assistantMessage(1, { input: 120, output: 30 })] },
        { id: 2, kind: "pi.user", model: [userMessage(2, "hello world")] },
      ],
    } as unknown as ConversationView;
    expect(getViewContextUsage(view, 1000)?.tokens).toBe(153);
    expect(
      getViewContextUsage(
        {
          ...view,
          entries: [
            ...view.entries,
            { id: 3, kind: "pi.compaction", model: [userMessage(3, "summary")] },
          ],
        } as unknown as ConversationView,
        1000,
      )?.tokens,
    ).toBeNull();
  });

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
