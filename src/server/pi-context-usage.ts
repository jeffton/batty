import { calculateContextTokens, estimateTokens } from "@earendil-works/pi-coding-agent";
import type { AgentSessionController as AgentSession } from "./agent-session-controller";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";

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
  if (message.role !== "assistant") return null;
  const assistant = message as AssistantMessage;
  if (
    assistant.stopReason === "aborted" ||
    assistant.stopReason === "error" ||
    !assistant.usage ||
    (compactionBoundaryTimestamp != null && assistant.timestamp <= compactionBoundaryTimestamp)
  )
    return null;
  const tokens = calculateContextTokens(assistant.usage);
  return tokens > 0 ? tokens : null;
}

function contextUsage(
  contextWindow: number,
  messages: readonly AgentMessage[],
  compactionBoundaryTimestamp: number | null,
): ContextUsage | undefined {
  if (contextWindow <= 0) return undefined;
  let trailingTokens = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    const usageTokens = usableAssistantContextTokens(message, compactionBoundaryTimestamp);
    if (usageTokens != null) {
      const tokens = usageTokens + trailingTokens;
      return { tokens, contextWindow, percent: (tokens / contextWindow) * 100 };
    }
    trailingTokens += estimateTokens(message);
  }
  if (compactionBoundaryTimestamp !== null) return { tokens: null, contextWindow, percent: null };
  return { tokens: trailingTokens, contextWindow, percent: (trailingTokens / contextWindow) * 100 };
}

export function getSessionContextUsage(session: SessionLike): ContextUsage | undefined {
  const latestCompaction = session.sessionManager
    .getBranch()
    .findLast((entry) => entry.type === "compaction");
  return contextUsage(
    session.model?.contextWindow ?? 0,
    session.messages,
    latestCompaction ? new Date(latestCompaction.timestamp).getTime() : null,
  );
}

/** Usage belongs to the captured native frame, not a newer controller/history read. */
export function getViewContextUsage(
  view: ConversationView,
  contextWindow: number,
): ContextUsage | undefined {
  const compaction = view.entries.findLast((entry) => entry.kind === "pi.compaction");
  const timestamp = compaction
    ? (compaction.model?.[0]?.timestamp ??
      (compaction.data as { timestamp?: number })?.timestamp ??
      0)
    : null;
  return contextUsage(
    contextWindow,
    view.entries.flatMap((entry) => entry.model ?? []),
    timestamp,
  );
}
