import { describe, expect, it, vi } from "vite-plus/test";
import { AgentSession, findCutPoint, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";

interface CompactionTestSession {
  agent: {
    prepareNextTurnWithContext?: (
      turn: { context: { messages: unknown[]; systemPrompt: string; tools: unknown[] } },
      signal?: AbortSignal,
    ) => Promise<{ context: { messages: unknown[]; systemPrompt: string; tools: unknown[] } }>;
    prepareNextTurn?: undefined;
    state: {
      messages: unknown[];
      tools: unknown[];
      model: { provider: string; id: string; contextWindow: number };
      thinkingLevel: string;
    };
  };
  model: { provider: string; id: string; contextWindow: number };
  settingsManager: {
    getCompactionSettings: () => {
      enabled: boolean;
      reserveTokens: number;
      keepRecentTokens: number;
    };
  };
  sessionManager: { getBranch: () => unknown[] };
  _runAutoCompaction: (
    reason: string,
    willRetry: boolean,
    signal?: AbortSignal,
  ) => Promise<boolean>;
  _compactBeforeNextAssistantResponse?: (
    context: { messages: unknown[]; systemPrompt: string; tools: unknown[] },
    signal?: AbortSignal,
  ) => Promise<{ messages: unknown[]; systemPrompt: string; tools: unknown[] }>;
  abortCompaction: () => void;
  _systemPromptOverride?: string;
  _baseSystemPrompt: string;
}

function assistant(totalTokens: number): AssistantMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "call-1",
        name: "read",
        arguments: { path: "large.txt" },
      },
    ],
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    usage: {
      input: totalTokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 1,
  };
}

function installNextTurnCompaction(session: CompactionTestSession): void {
  const prototype = AgentSession.prototype as unknown as {
    _compactBeforeNextAssistantResponse: NonNullable<
      CompactionTestSession["_compactBeforeNextAssistantResponse"]
    >;
    _installAgentNextTurnRefresh: (this: CompactionTestSession) => void;
  };
  session._compactBeforeNextAssistantResponse = prototype._compactBeforeNextAssistantResponse;
  prototype._installAgentNextTurnRefresh.call(session);
}

describe("Pi between-turn compaction patch", () => {
  it("keeps an assistant tool call when trailing results exceed the retention budget", () => {
    const entry = (id: string, message: unknown): SessionEntry =>
      ({
        type: "message",
        id,
        parentId: null,
        timestamp: new Date().toISOString(),
        message,
      }) as SessionEntry;
    const entries = [
      {
        type: "model_change",
        id: "model",
        parentId: null,
        timestamp: new Date().toISOString(),
        provider: "openai",
        modelId: "test-model",
      } as SessionEntry,
      entry("user", { role: "user", content: "Investigate", timestamp: 1 }),
      entry("assistant", {
        ...assistant(100),
        content: [
          { type: "toolCall", id: "call-1", name: "read", arguments: { path: "one.txt" } },
          { type: "toolCall", id: "call-2", name: "read", arguments: { path: "two.txt" } },
        ],
      }),
      entry("tool-result-1", {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "x".repeat(80) }],
        isError: false,
        timestamp: 2,
      }),
      entry("tool-result-2", {
        role: "toolResult",
        toolCallId: "call-2",
        toolName: "read",
        content: [{ type: "text", text: "y".repeat(80) }],
        isError: false,
        timestamp: 3,
      }),
    ];

    expect(findCutPoint(entries, 0, entries.length, 30)).toStrictEqual({
      firstKeptEntryIndex: 2,
      turnStartIndex: 1,
      isSplitTurn: true,
    });
  });

  it("compacts before the next model request when tool results cross the threshold", async () => {
    const compactedMessages = [{ role: "compactionSummary", summary: "Preserved work" }];
    let branch: unknown[] = [];
    const runAutoCompaction = vi.fn(async () => {
      branch = [
        {
          type: "compaction",
          id: "compaction-1",
          parentId: "tool-result-1",
          timestamp: new Date(2).toISOString(),
          summary: "Preserved work",
          firstKeptEntryId: "tool-result-1",
          tokensBefore: 95,
        },
      ];
      session.agent.state.messages = compactedMessages;
      return false;
    });
    const session: CompactionTestSession = {
      agent: {
        state: {
          messages: [],
          tools: [],
          model: { provider: "openai", id: "test-model", contextWindow: 100 },
          thinkingLevel: "medium",
        },
      },
      model: { provider: "openai", id: "test-model", contextWindow: 100 },
      settingsManager: {
        getCompactionSettings: () => ({
          enabled: true,
          reserveTokens: 20,
          keepRecentTokens: 10,
        }),
      },
      sessionManager: { getBranch: () => branch },
      _runAutoCompaction: runAutoCompaction,
      abortCompaction: vi.fn(),
      _baseSystemPrompt: "system",
    };
    installNextTurnCompaction(session);

    const messages = [
      assistant(75),
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "x".repeat(100) }],
        isError: false,
        timestamp: 2,
      },
    ];
    const result = await session.agent.prepareNextTurnWithContext?.({
      context: { messages, systemPrompt: "old", tools: [] },
    });

    expect(runAutoCompaction).toHaveBeenCalledWith("threshold", false, undefined);
    expect(result?.context.messages).toStrictEqual(compactedMessages);
  });

  it("compacts usage-less context after an earlier compaction", async () => {
    const compactedMessages = [{ role: "compactionSummary", summary: "Preserved work again" }];
    let branch: unknown[] = [
      {
        type: "compaction",
        id: "compaction-1",
        parentId: "previous-tool-result",
        timestamp: new Date(2).toISOString(),
        summary: "Earlier work",
        firstKeptEntryId: "previous-tool-result",
        tokensBefore: 95,
      },
    ];
    const runAutoCompaction = vi.fn(async () => {
      branch = [
        ...branch,
        {
          type: "compaction",
          id: "compaction-2",
          parentId: "current-tool-result",
          timestamp: new Date(4).toISOString(),
          summary: "Preserved work again",
          firstKeptEntryId: "current-tool-result",
          tokensBefore: 95,
        },
      ];
      session.agent.state.messages = compactedMessages;
      return false;
    });
    const session: CompactionTestSession = {
      agent: {
        state: {
          messages: [],
          tools: [],
          model: { provider: "openai", id: "test-model", contextWindow: 100 },
          thinkingLevel: "medium",
        },
      },
      model: { provider: "openai", id: "test-model", contextWindow: 100 },
      settingsManager: {
        getCompactionSettings: () => ({
          enabled: true,
          reserveTokens: 20,
          keepRecentTokens: 10,
        }),
      },
      sessionManager: { getBranch: () => branch },
      _runAutoCompaction: runAutoCompaction,
      abortCompaction: vi.fn(),
      _baseSystemPrompt: "system",
    };
    installNextTurnCompaction(session);

    const result = await session.agent.prepareNextTurnWithContext?.({
      context: {
        messages: [{ role: "user", content: "x".repeat(400), timestamp: 3 }],
        systemPrompt: "old",
        tools: [],
      },
    });

    expect(runAutoCompaction).toHaveBeenCalledWith("threshold", false, undefined);
    expect(result?.context.messages).toStrictEqual(compactedMessages);
  });

  it("stops before an oversized model request when compaction fails", async () => {
    const session: CompactionTestSession = {
      agent: {
        state: {
          messages: [],
          tools: [],
          model: { provider: "openai", id: "test-model", contextWindow: 100 },
          thinkingLevel: "medium",
        },
      },
      model: { provider: "openai", id: "test-model", contextWindow: 100 },
      settingsManager: {
        getCompactionSettings: () => ({
          enabled: true,
          reserveTokens: 20,
          keepRecentTokens: 10,
        }),
      },
      sessionManager: { getBranch: () => [] },
      _runAutoCompaction: vi.fn(async () => false),
      abortCompaction: vi.fn(),
      _baseSystemPrompt: "system",
    };
    installNextTurnCompaction(session);

    await expect(
      session.agent.prepareNextTurnWithContext?.({
        context: { messages: [assistant(95)], systemPrompt: "old", tools: [] },
      }),
    ).rejects.toThrow("Auto-compaction failed before the next model request");
  });

  it("leaves normal turns to the standard agent loop", async () => {
    const runAutoCompaction = vi.fn(async () => false);
    const session: CompactionTestSession = {
      agent: {
        state: {
          messages: [],
          tools: [],
          model: { provider: "openai", id: "test-model", contextWindow: 100 },
          thinkingLevel: "medium",
        },
      },
      model: { provider: "openai", id: "test-model", contextWindow: 100 },
      settingsManager: {
        getCompactionSettings: () => ({
          enabled: true,
          reserveTokens: 20,
          keepRecentTokens: 10,
        }),
      },
      sessionManager: { getBranch: () => [] },
      _runAutoCompaction: runAutoCompaction,
      abortCompaction: vi.fn(),
      _baseSystemPrompt: "system",
    };
    installNextTurnCompaction(session);
    const messages = [assistant(10)];

    const result = await session.agent.prepareNextTurnWithContext?.({
      context: { messages, systemPrompt: "old", tools: [] },
    });

    expect(runAutoCompaction).not.toHaveBeenCalled();
    expect(result?.context.messages).toBe(messages);
  });

  it("does not start summarization when the run is aborted during authentication", async () => {
    let finishAuthentication!: (auth: { apiKey: string }) => void;
    const authenticationPending = new Promise<{ apiKey: string }>((resolve) => {
      finishAuthentication = resolve;
    });
    const getBranch = vi.fn(() => []);
    const controller = new AbortController();
    const session = {
      model: { provider: "openai", id: "test-model", contextWindow: 100 },
      agent: { streamFunction: vi.fn() },
      settingsManager: {
        getCompactionSettings: () => ({
          enabled: true,
          reserveTokens: 20,
          keepRecentTokens: 10,
        }),
      },
      sessionManager: { getBranch },
      _getSummarizationRequestAuth: vi.fn(async () => authenticationPending),
      _autoCompactionAbortController: undefined,
    };
    const runAutoCompaction = (
      AgentSession.prototype as unknown as {
        _runAutoCompaction: (
          this: typeof session,
          reason: string,
          willRetry: boolean,
          signal?: AbortSignal,
        ) => Promise<boolean>;
      }
    )._runAutoCompaction;

    const resultPromise = runAutoCompaction.call(session, "threshold", false, controller.signal);
    await Promise.resolve();
    controller.abort();
    finishAuthentication({ apiKey: "test-key" });

    await expect(resultPromise).resolves.toBe(false);
    expect(getBranch).not.toHaveBeenCalled();
  });
});
