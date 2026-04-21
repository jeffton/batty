import {
  calculateContextTokens,
  estimateTokens,
  getLatestCompactionEntry,
  type AgentSession,
} from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";

interface ContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

type AgentMessage = AgentSession["messages"][number];

type SessionLike = Pick<AgentSession, "model" | "messages" | "sessionManager">;

function usableAssistantContextTokens(
  message: AgentMessage,
  compactionBoundaryTimestamp: number | null,
): number | null {
  if (message.role !== "assistant") {
    return null;
  }

  const assistant = message as AssistantMessage;
  if (
    assistant.stopReason === "aborted" ||
    assistant.stopReason === "error" ||
    !assistant.usage ||
    (compactionBoundaryTimestamp != null && assistant.timestamp <= compactionBoundaryTimestamp)
  ) {
    return null;
  }

  const tokens = calculateContextTokens(assistant.usage);
  return tokens > 0 ? tokens : null;
}

export function getSessionContextUsage(session: SessionLike): ContextUsage | undefined {
  const contextWindow = session.model?.contextWindow ?? 0;
  if (contextWindow <= 0) {
    return undefined;
  }

  const latestCompaction = getLatestCompactionEntry(session.sessionManager.getBranch());
  const compactionBoundaryTimestamp = latestCompaction
    ? new Date(latestCompaction.timestamp).getTime()
    : null;

  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const usageTokens = usableAssistantContextTokens(
      session.messages[index] as AgentMessage,
      compactionBoundaryTimestamp,
    );
    if (usageTokens == null) {
      continue;
    }

    let trailingTokens = 0;
    for (
      let trailingIndex = index + 1;
      trailingIndex < session.messages.length;
      trailingIndex += 1
    ) {
      trailingTokens += estimateTokens(session.messages[trailingIndex] as AgentMessage);
    }

    const tokens = usageTokens + trailingTokens;
    return {
      tokens,
      contextWindow,
      percent: (tokens / contextWindow) * 100,
    };
  }

  if (latestCompaction) {
    return { tokens: null, contextWindow, percent: null };
  }

  const estimatedTokens = session.messages.reduce(
    (total, message) => total + estimateTokens(message as AgentMessage),
    0,
  );
  return {
    tokens: estimatedTokens,
    contextWindow,
    percent: (estimatedTokens / contextWindow) * 100,
  };
}
