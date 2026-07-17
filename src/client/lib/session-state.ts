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
    hasMoreMessages: session.hasMoreMessages || session.totalMessageCount > session.messages.length,
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
