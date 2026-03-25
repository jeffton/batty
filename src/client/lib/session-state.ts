import type { ActiveToolRun, SessionState, UiMessage } from "@/shared/types";

function lastMessageTimestamp(messages: UiMessage[]): number | undefined {
  const lastMessage = messages.at(-1);
  return typeof lastMessage?.timestamp === "number" ? lastMessage.timestamp : undefined;
}

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
  const totalMessageCount =
    typeof session.totalMessageCount === "number" && Number.isFinite(session.totalMessageCount)
      ? Math.max(0, session.totalMessageCount)
      : messages.length;

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
    totalMessageCount,
    hasMoreMessages: Boolean(session.hasMoreMessages) || totalMessageCount > messages.length,
    messages,
    activeTools: Array.isArray(session.activeTools) ? session.activeTools : [],
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

  return normalizeSessionState({
    ...normalizedIncoming,
    messages: mergeSessionMessages(normalizedIncoming, normalizedPrevious),
    activeTools: mergeRetainedActiveTools(normalizedIncoming, normalizedPrevious),
  });
}
