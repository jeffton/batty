import type { SessionSnapshot, SessionState } from "@/shared/types";

/** UI fixture builder for component tests; production only stores native snapshots. */
export function snapshotFromPresentation(session: SessionState): SessionSnapshot {
  const {
    messages = [],
    activeAssistant,
    activeTools: _tools,
    isStreaming,
    isCompacting,
    queuedPrompts = [],
    pendingMessageCount: _pending,
    ...metadata
  } = session;
  return {
    metadata,
    messages,
    historyVersion: 0,
    documents: {
      "pi.live": {
        ...(isStreaming ? { run: { taskId: 1 as never, inputs: [] } } : {}),
        ...(isCompacting
          ? {
              compactions: [
                { taskId: 2 as never, reason: "manual" as never, blocking: true, attempt: 1 },
              ],
            }
          : {}),
        ...(activeAssistant
          ? {
              generation: {
                attempt: 1,
                message: {
                  ...activeAssistant,
                  content: activeAssistant.blocks,
                } as never,
              },
            }
          : {}),
      },
      "pi.inbox": {
        items: queuedPrompts.map((prompt, index) => ({
          id: (prompt.submissionId ?? index + 1) as never,
          mode: prompt.kind,
          content: (prompt.blocks ?? [{ type: "text", text: prompt.text }]) as never,
        })),
      },
      "pi.agent": {},
      "pi.usage": { models: {}, tools: {} },
    },
    queuedClientMessageIds: Object.fromEntries(
      queuedPrompts.map((prompt, index) => [
        prompt.submissionId ?? index + 1,
        prompt.clientMessageId ?? "",
      ]),
    ),
  };
}

export function makeSnapshot(
  sessionId = "session-a",
  overrides: Partial<SessionSnapshot> = {},
): SessionSnapshot {
  return {
    metadata: {
      id: `web-${sessionId}`,
      sessionId,
      workspaceId: "batty",
      cwd: "/tmp/batty",
      path: `/tmp/${sessionId}.jsonl`,
      thinkingLevel: "medium",
      availableThinkingLevels: ["off", "medium"],
      updatedAt: 1,
      contextTokens: null,
      contextWindow: null,
      contextPercent: null,
      totalMessageCount: 0,
      hasMoreMessages: false,
    },
    messages: [],
    historyVersion: 0,
    queuedClientMessageIds: {},
    documents: {
      "pi.live": {},
      "pi.inbox": { items: [] },
      "pi.agent": {},
      "pi.usage": { models: {}, tools: {} },
    },
    ...overrides,
  };
}
