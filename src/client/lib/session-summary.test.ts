import { describe, expect, it } from "vite-plus/test";
import { mergeSessionSummaries, toSessionSummary } from "@/client/lib/session-summary";
import type { SessionState, SessionSummary } from "@/shared/types";

const baseSession: SessionState = {
  id: "web-1",
  sessionId: "session-1",
  workspaceId: "batty",
  cwd: "/tmp/batty",
  model: "anthropic/claude-sonnet-4",
  modelLabel: "Claude Sonnet 4 · anthropic",
  thinkingLevel: "medium",
  availableThinkingLevels: ["off", "low", "medium", "high"],
  isStreaming: false,
  pendingMessageCount: 0,
  updatedAt: 200,
  contextTokens: null,
  contextWindow: null,
  contextPercent: null,
  totalMessageCount: 1,
  hasMoreMessages: false,
  messages: [
    {
      id: "user-1",
      role: "user",
      timestamp: 200,
      blocks: [{ type: "text", text: "hello from the new session" }],
    },
  ],
  activeTools: [],
};

describe("session-summary", () => {
  it("creates a resumable summary from session state when a path exists", () => {
    const summary = toSessionSummary({
      ...baseSession,
      path: "/tmp/batty/.pi/session.jsonl",
      title: "Fresh session",
    });

    expect(summary).toEqual({
      id: "/tmp/batty/.pi/session.jsonl",
      sessionId: "session-1",
      name: "Fresh session",
      path: "/tmp/batty/.pi/session.jsonl",
      firstMessage: "hello from the new session",
      updatedAt: 200,
      messageCount: 1,
      workspaceId: "batty",
      model: "anthropic/claude-sonnet-4",
    });
  });

  it("uses the total message count when only the recent window is loaded", () => {
    const summary = toSessionSummary({
      ...baseSession,
      messages: [baseSession.messages[0]],
      totalMessageCount: 120,
      hasMoreMessages: true,
    } as unknown as SessionState);

    expect(summary.messageCount).toBe(120);
  });

  it("merges server and local summaries by session id", () => {
    const persisted: SessionSummary = {
      id: "/tmp/batty/.pi/session.jsonl",
      sessionId: "session-1",
      path: "/tmp/batty/.pi/session.jsonl",
      name: "Persisted session",
      firstMessage: "older title",
      updatedAt: 100,
      messageCount: 1,
      workspaceId: "batty",
      model: "anthropic/claude-sonnet-4",
    };

    const merged = mergeSessionSummaries([persisted], [toSessionSummary(baseSession)]);

    expect(merged).toEqual([
      {
        id: "/tmp/batty/.pi/session.jsonl",
        sessionId: "session-1",
        path: "/tmp/batty/.pi/session.jsonl",
        name: "Persisted session",
        firstMessage: "hello from the new session",
        updatedAt: 200,
        messageCount: 1,
        workspaceId: "batty",
        model: "anthropic/claude-sonnet-4",
      },
    ]);
  });

  it("keeps the newest sessions first", () => {
    const older: SessionSummary = {
      id: "older",
      sessionId: "older",
      firstMessage: "older",
      updatedAt: 100,
      messageCount: 1,
      workspaceId: "batty",
    };

    const newer: SessionSummary = {
      id: "newer",
      sessionId: "newer",
      firstMessage: "newer",
      updatedAt: 300,
      messageCount: 1,
      workspaceId: "batty",
    };

    expect(mergeSessionSummaries([older], [newer]).map((session) => session.sessionId)).toEqual([
      "newer",
      "older",
    ]);
  });
});
