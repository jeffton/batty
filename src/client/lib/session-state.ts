import type { ActiveToolRun, SessionState, UiMessage } from "@/shared/types";

function hasToolCall(message: UiMessage | undefined, toolCallId: string): boolean {
  return Boolean(
    message &&
    "blocks" in message &&
    message.blocks.some((block) => block.type === "toolCall" && block.id === toolCallId),
  );
}

function hasToolResult(messages: UiMessage[], toolCallId: string): boolean {
  return messages.some(
    (message) => message.role === "toolResult" && message.toolCallId === toolCallId,
  );
}

function mergeRetainedActiveTools(
  incoming: SessionState,
  previous?: SessionState,
): ActiveToolRun[] {
  if (!previous || previous.sessionId !== incoming.sessionId || previous.activeTools.length === 0) {
    return incoming.activeTools;
  }
  if (incoming.activeTools.length === 0 && !incoming.isStreaming) {
    return [];
  }

  const incomingToolIds = new Set(incoming.activeTools.map((tool) => tool.toolCallId));
  const retained = previous.activeTools.filter((tool) => {
    if (incomingToolIds.has(tool.toolCallId)) {
      return false;
    }

    if (hasToolResult(incoming.messages, tool.toolCallId)) {
      return false;
    }

    return (
      incoming.messages.some((message) => hasToolCall(message, tool.toolCallId)) ||
      hasToolCall(incoming.activeAssistant, tool.toolCallId)
    );
  });

  return [...incoming.activeTools, ...retained];
}

function messageIndex(message: UiMessage): number {
  const separator = message.id.lastIndexOf("-");
  return Number.parseInt(message.id.slice(separator + 1), 10);
}

function mergeSummaryMessages(incoming: UiMessage[], previous: UiMessage[]): UiMessage[] {
  const messages = new Map(previous.map((message) => [message.id, message]));
  for (const message of incoming) {
    const existing = messages.get(message.id);
    if (message.role === "assistant" && existing?.role === "assistant") {
      messages.set(message.id, {
        ...message,
        blocks: [
          ...message.blocks,
          ...existing.blocks.filter((block) => block.type === "toolCall"),
        ],
      });
    } else {
      messages.set(message.id, message);
    }
  }
  return [...messages.values()].sort((left, right) => messageIndex(left) - messageIndex(right));
}

function withoutPersistedActiveAssistant(
  messages: UiMessage[],
  activeAssistant: SessionState["activeAssistant"],
): UiMessage[] {
  if (!activeAssistant) {
    return messages;
  }

  return messages.filter(
    (message) => message.role !== "assistant" || message.timestamp !== activeAssistant.timestamp,
  );
}

function mergeSummaryAssistant(
  incoming: SessionState["activeAssistant"],
  previous: SessionState["activeAssistant"],
): SessionState["activeAssistant"] {
  if (!incoming) {
    return previous;
  }
  if (!previous || incoming.timestamp !== previous.timestamp) {
    return incoming;
  }

  return {
    ...incoming,
    blocks: [
      ...incoming.blocks,
      ...previous.blocks.filter(
        (block) =>
          block.type === "toolCall" &&
          !incoming.blocks.some(
            (incomingBlock) => incomingBlock.type === "toolCall" && incomingBlock.id === block.id,
          ),
      ),
    ],
  };
}

function mergeSessionMessages(incoming: SessionState, previous?: SessionState): UiMessage[] {
  if (!previous || previous.sessionId !== incoming.sessionId || previous.messages.length === 0) {
    return incoming.messages;
  }

  if (incoming.messages.length === 0) {
    return incoming.totalMessageCount === 0 ? [] : previous.messages;
  }

  const previousIds = previous.messages.map((message) => message.id);
  const incomingIds = incoming.messages.map((message) => message.id);
  const overlapStart = previousIds.indexOf(incomingIds[0] ?? "");
  if (overlapStart === -1) {
    return incoming.messages;
  }

  const overlapLength = Math.min(previousIds.length - overlapStart, incomingIds.length);
  for (let index = 0; index < overlapLength; index += 1) {
    if (previousIds[overlapStart + index] !== incomingIds[index]) {
      return incoming.messages;
    }
  }

  return [...previous.messages.slice(0, overlapStart), ...incoming.messages];
}

export function normalizeSessionState(session: SessionState | undefined): SessionState | undefined {
  if (!session) {
    return undefined;
  }

  return {
    ...session,
    availableThinkingLevels: [...new Set(session.availableThinkingLevels)],
    hasMoreMessages:
      session.hasMoreMessages ||
      (session.messagesDetailLevel !== "summary" &&
        session.totalMessageCount > session.messages.length),
  };
}

export function mergeSessionState(
  incoming: SessionState | undefined,
  previous?: SessionState,
): SessionState | undefined {
  const normalizedIncoming = normalizeSessionState(incoming);
  if (!normalizedIncoming) {
    return undefined;
  }

  const normalizedPrevious = normalizeSessionState(previous);
  if (!normalizedPrevious) {
    return normalizedIncoming;
  }

  const summaryReset = normalizedIncoming.messagesDetailLevel === "summary";
  const retainDetailedMessages =
    summaryReset && normalizedPrevious.messagesDetailLevel !== "summary";
  const retainLiveToolState = summaryReset && normalizedIncoming.isStreaming;
  let messages = retainDetailedMessages
    ? mergeSummaryMessages(normalizedIncoming.messages, normalizedPrevious.messages)
    : mergeSessionMessages(normalizedIncoming, normalizedPrevious);
  if (retainLiveToolState && !normalizedIncoming.activeAssistant) {
    messages = withoutPersistedActiveAssistant(messages, normalizedPrevious.activeAssistant);
  }
  const activeAssistant = retainLiveToolState
    ? mergeSummaryAssistant(normalizedIncoming.activeAssistant, normalizedPrevious.activeAssistant)
    : normalizedIncoming.activeAssistant;

  return normalizeSessionState({
    ...normalizedIncoming,
    messagesDetailLevel: normalizedIncoming.messagesDetailLevel,
    messages,
    activeAssistant,
    activeTools: mergeRetainedActiveTools(
      { ...normalizedIncoming, messages, activeAssistant },
      normalizedPrevious,
    ),
  });
}
