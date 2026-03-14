import type { SessionState, UiMessage } from "@/shared/types";

function lastMessageTimestamp(messages: UiMessage[]): number | undefined {
  const lastMessage = messages.at(-1);
  return typeof lastMessage?.timestamp === "number" ? lastMessage.timestamp : undefined;
}

export function normalizeSessionState(session: SessionState | undefined): SessionState | undefined {
  if (!session) {
    return undefined;
  }

  const messages = Array.isArray(session.messages) ? session.messages : [];
  const thinkingLevel =
    typeof session.thinkingLevel === "string" && session.thinkingLevel.length > 0
      ? session.thinkingLevel
      : "off";
  const availableThinkingLevels = Array.isArray(session.availableThinkingLevels)
    ? session.availableThinkingLevels.filter(
        (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
      )
    : [];
  const updatedAtCandidates = [
    typeof session.updatedAt === "number" ? session.updatedAt : undefined,
    lastMessageTimestamp(messages),
    typeof session.activeAssistant?.timestamp === "number"
      ? session.activeAssistant.timestamp
      : undefined,
  ].filter((candidate): candidate is number => Number.isFinite(candidate));

  return {
    ...session,
    path: typeof session.path === "string" && session.path.length > 0 ? session.path : undefined,
    model:
      typeof session.model === "string" && session.model.length > 0 ? session.model : undefined,
    modelLabel:
      typeof session.modelLabel === "string" && session.modelLabel.length > 0
        ? session.modelLabel
        : undefined,
    thinkingLevel,
    availableThinkingLevels:
      availableThinkingLevels.length > 0 ? [...new Set(availableThinkingLevels)] : [thinkingLevel],
    isStreaming: Boolean(session.isStreaming),
    pendingMessageCount:
      typeof session.pendingMessageCount === "number" &&
      Number.isFinite(session.pendingMessageCount)
        ? session.pendingMessageCount
        : 0,
    updatedAt: updatedAtCandidates[0] ?? Date.now(),
    contextTokens:
      typeof session.contextTokens === "number" && Number.isFinite(session.contextTokens)
        ? session.contextTokens
        : null,
    contextWindow:
      typeof session.contextWindow === "number" && Number.isFinite(session.contextWindow)
        ? session.contextWindow
        : null,
    contextPercent:
      typeof session.contextPercent === "number" && Number.isFinite(session.contextPercent)
        ? session.contextPercent
        : null,
    messages,
    activeTools: Array.isArray(session.activeTools) ? session.activeTools : [],
  };
}
