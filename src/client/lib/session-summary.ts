import type { SessionState, SessionSummary, UiContentBlock, UiMessage } from "@/shared/types";

function blockText(block: UiContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "thinking":
      return block.thinking;
    default:
      return "";
  }
}

function messageText(message: UiMessage | undefined): string {
  if (!message) {
    return "";
  }

  return message.blocks.map(blockText).join("\n").replace(/\s+/g, " ").trim();
}

export function firstUserMessage(session: SessionState): string {
  const message = session.messages.find((candidate) => candidate.role === "user");
  return messageText(message);
}

export function toSessionSummary(session: SessionState): SessionSummary {
  const firstMessage = firstUserMessage(session);
  const updatedAt = Number.isFinite(session.updatedAt)
    ? session.updatedAt
    : session.messages.at(-1)?.timestamp || Date.now();

  return {
    id: session.path || session.sessionId,
    sessionId: session.sessionId,
    name: session.title,
    path: session.path,
    firstMessage,
    updatedAt,
    messageCount: session.totalMessageCount,
    workspaceId: session.workspaceId,
    model: session.model,
  };
}

function mergePair(left: SessionSummary, right: SessionSummary): SessionSummary {
  const newer = left.updatedAt >= right.updatedAt ? left : right;
  const older = newer === left ? right : left;

  return {
    ...older,
    ...newer,
    id: newer.path || older.path || newer.id || older.id,
    path: newer.path || older.path,
    name: newer.name || older.name,
    firstMessage: newer.firstMessage || older.firstMessage,
    updatedAt: Math.max(left.updatedAt, right.updatedAt),
    messageCount: Math.max(left.messageCount, right.messageCount),
    model: newer.model || older.model,
  };
}

export function mergeSessionSummaries(...groups: SessionSummary[][]): SessionSummary[] {
  const bySessionId = new Map<string, SessionSummary>();

  for (const group of groups) {
    for (const summary of group) {
      const existing = bySessionId.get(summary.sessionId);
      bySessionId.set(summary.sessionId, existing ? mergePair(existing, summary) : { ...summary });
    }
  }

  return [...bySessionId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}
