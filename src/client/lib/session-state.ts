import type { SessionSnapshot, UiMessage } from "@/shared/types";

/** Preserve loaded history on overlapping windows, never preserve a previous live document. */
export function mergeHistory(
  incoming: UiMessage[],
  previous: UiMessage[],
  summary = false,
): UiMessage[] {
  if (summary && previous.length) {
    const messages = new Map(previous.map((message) => [message.id, message]));
    for (const message of incoming) {
      const existing = messages.get(message.id);
      messages.set(
        message.id,
        message.role === "assistant" && existing?.role === "assistant"
          ? {
              ...message,
              blocks: [
                ...message.blocks,
                ...existing.blocks.filter(
                  (block) =>
                    block.type === "toolCall" &&
                    !message.blocks.some(
                      (next) => next.type === "toolCall" && next.id === block.id,
                    ),
                ),
              ],
            }
          : message,
      );
    }
    return [...messages.values()];
  }
  if (!incoming.length) return incoming;
  const overlap = previous.findIndex((message) => message.id === incoming[0]?.id);
  if (overlap < 0) return incoming;
  return [...previous.slice(0, overlap), ...incoming];
}

export function mergeSessionSnapshot(
  incoming: SessionSnapshot,
  previous?: SessionSnapshot,
): SessionSnapshot {
  if (!previous || previous.metadata.sessionId !== incoming.metadata.sessionId) return incoming;
  if (incoming.historyVersion < previous.historyVersion) {
    return { ...incoming, messages: previous.messages, historyVersion: previous.historyVersion };
  }
  return {
    ...incoming,
    messages: mergeHistory(
      incoming.messages,
      previous.messages,
      incoming.metadata.messagesDetailLevel === "summary" &&
        incoming.metadata.totalMessageCount > 0,
    ),
  };
}
