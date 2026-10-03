import { describe, expect, it } from "vite-plus/test";
import {
  applyServerEvent,
  shouldUpdateSessionSummary,
  shouldWriteSessionCache,
} from "@/client/lib/session-events";
import type { ServerEvent, SessionState } from "@/shared/types";

const baseState: SessionState = {
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
  pendingMessageCount: 0,
  updatedAt: 100,
  contextTokens: 12345,
  contextWindow: 200000,
  contextPercent: 6.2,
  totalMessageCount: 0,
  hasMoreMessages: false,
  messages: [],
  activeTools: [],
};

const { messages: _messages, activeTools: _activeTools, ...baseMetadata } = baseState;

describe("session event policies", () => {
  it.each([
    [{ type: "reset", state: baseState }, true, true],
    [{ type: "state", state: baseMetadata }, false, true],
    [{ type: "assistant", assistant: undefined }, false, false],
    [{ type: "tools", tools: [] }, false, false],
  ] satisfies [ServerEvent, boolean, boolean][])(
    "selects cache and summary updates for %j",
    (event, cache, summary) => {
      expect(shouldWriteSessionCache(event)).toBe(cache);
      expect(shouldUpdateSessionSummary(event)).toBe(summary);
    },
  );
});

describe("applyServerEvent", () => {
  it("applies metadata-only state updates without dropping loaded messages", () => {
    const previous: SessionState = {
      ...baseState,
      messages: [
        {
          id: "user-1",
          role: "user",
          timestamp: 1,
          blocks: [{ type: "text", text: "hello" }],
        },
      ],
    };

    const next = applyServerEvent(previous, {
      type: "state",
      state: { ...baseMetadata, isStreaming: false, pendingMessageCount: 2, updatedAt: 200 },
    });

    expect(next?.pendingMessageCount).toBe(2);
    expect(next?.isStreaming).toBe(false);
    expect(next?.messages).toEqual(previous.messages);
  });

  it("replaces reset snapshots", () => {
    const next = applyServerEvent(baseState, {
      type: "reset",
      state: { ...baseState, pendingMessageCount: 2 },
    });
    expect(next?.pendingMessageCount).toBe(2);
  });

  it("accepts an authoritative reset when server revisions restart", () => {
    const next = applyServerEvent(
      { ...baseState, revision: 42, streamId: "old-process", isStreaming: true },
      {
        type: "reset",
        revision: 0,
        streamId: "new-process",
        state: { ...baseState, revision: 0, streamId: "new-process", isStreaming: false },
      },
    );

    expect(next?.revision).toBe(0);
    expect(next?.isStreaming).toBe(false);
    expect(next?.streamId).toBe("new-process");
  });

  it("ignores an older reset from the same process after an idle refresh", () => {
    const idle = { ...baseState, revision: 6, streamId: "same-process", isStreaming: false };
    expect(
      applyServerEvent(idle, {
        type: "reset",
        revision: 5,
        streamId: "same-process",
        state: { ...baseState, revision: 5, streamId: "same-process" },
      }),
    ).toBe(idle);
  });

  it("drops cached tool output when an idle reset snapshot arrives without active tools", () => {
    const previous: SessionState = {
      ...baseState,
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          turnPhase: "intermediate",
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
      type: "reset",
      state: { ...previous, isStreaming: false, activeTools: [] },
    });

    expect(next?.activeTools).toEqual([]);
  });

  it("updates the active assistant during streaming", () => {
    const next = applyServerEvent(baseState, {
      type: "assistant",
      assistant: {
        id: "assistant-1",
        role: "assistant",
        turnPhase: "pending",
        timestamp: 1,
        blocks: [{ type: "text", text: "hello from batty" }],
      },
    });
    expect(next?.activeAssistant?.blocks[0]).toEqual({ type: "text", text: "hello from batty" });
  });

  it("appends assistant deltas and advances the stream revision", () => {
    const next = applyServerEvent(
      {
        ...baseState,
        revision: 3,
        activeAssistant: {
          id: "assistant-1",
          role: "assistant",
          turnPhase: "pending",
          timestamp: 1,
          blocks: [{ type: "text", text: "hello" }],
        },
      },
      {
        type: "assistant-delta",
        revision: 4,
        contentIndex: 0,
        blockType: "text",
        delta: " world",
      },
    );

    expect(next?.activeAssistant?.blocks).toEqual([{ type: "text", text: "hello world" }]);
    expect(next?.revision).toBe(4);
  });

  it("ignores duplicate revisioned deltas", () => {
    const state = {
      ...baseState,
      revision: 4,
      activeAssistant: {
        id: "assistant-1",
        role: "assistant" as const,
        turnPhase: "final" as const,
        timestamp: 1,
        blocks: [{ type: "text" as const, text: "complete" }],
      },
    };

    const next = applyServerEvent(state, {
      type: "assistant-delta",
      revision: 4,
      contentIndex: 0,
      blockType: "text",
      delta: "complete",
    });

    expect(next).toBe(state);
    expect(next?.activeAssistant?.blocks).toEqual([{ type: "text", text: "complete" }]);
  });

  it("applies append-only tool deltas", () => {
    const next = applyServerEvent(
      {
        ...baseState,
        activeTools: [
          {
            toolCallId: "call-1",
            toolName: "bash",
            args: { command: "printf ab" },
            blocks: [{ type: "text", text: "a" }],
            status: "running",
            isError: false,
          },
        ],
      },
      {
        type: "tool-delta",
        toolCallId: "call-1",
        deltas: [{ contentIndex: 0, blockType: "text", delta: "b" }],
      },
    );

    expect(next?.activeTools[0]?.blocks).toEqual([{ type: "text", text: "ab" }]);
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
