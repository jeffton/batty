import { mergeSessionState, normalizeSessionState } from "@/client/lib/session-state";
import type { ActiveToolRun, ServerEvent, SessionState } from "@/shared/types";

export function shouldUpdateSessionSummary(event: ServerEvent): boolean {
  return event.type === "reset" || event.type === "state";
}

export function shouldWriteSessionCache(event: ServerEvent): boolean {
  return event.type === "reset";
}

function applyAssistantDelta(
  assistant: SessionState["activeAssistant"],
  event: Extract<ServerEvent, { type: "assistant-delta" }>,
): SessionState["activeAssistant"] {
  if (!assistant) {
    return assistant;
  }

  const blocks = [...assistant.blocks];
  const current = blocks[event.contentIndex];
  if (event.blockType === "text") {
    blocks[event.contentIndex] = {
      type: "text",
      text: current?.type === "text" ? current.text + event.delta : event.delta,
    };
  } else {
    blocks[event.contentIndex] = {
      type: "thinking",
      thinking: current?.type === "thinking" ? current.thinking + event.delta : event.delta,
    };
  }

  return { ...assistant, blocks };
}

function applyToolDelta(
  tools: ActiveToolRun[],
  event: Extract<ServerEvent, { type: "tool-delta" }>,
): ActiveToolRun[] {
  return tools.map((tool) => {
    if (tool.toolCallId !== event.toolCallId) {
      return tool;
    }

    const blocks = [...tool.blocks];
    for (const delta of event.deltas) {
      const current = blocks[delta.contentIndex];
      blocks[delta.contentIndex] =
        delta.blockType === "text"
          ? {
              type: "text",
              text: current?.type === "text" ? current.text + delta.delta : delta.delta,
            }
          : {
              type: "thinking",
              thinking: current?.type === "thinking" ? current.thinking + delta.delta : delta.delta,
            };
    }

    return {
      ...tool,
      blocks,
      details: event.details ?? tool.details,
    };
  });
}

function withEventRevision(state: SessionState, event: ServerEvent): SessionState {
  return typeof event.revision === "number" ? { ...state, revision: event.revision } : state;
}

function mergeTools(previous: ActiveToolRun[], incoming: ActiveToolRun[]): ActiveToolRun[] {
  if (incoming.length === 0) {
    return [];
  }

  const byId = new Map(previous.map((tool) => [tool.toolCallId, tool]));
  for (const tool of incoming) {
    byId.set(tool.toolCallId, tool);
  }
  return [...byId.values()];
}

export function applyServerEvent(
  state: SessionState | undefined,
  event: ServerEvent,
): SessionState | undefined {
  if (
    state &&
    event.type !== "reset" &&
    typeof state.revision === "number" &&
    typeof event.revision === "number" &&
    event.revision <= state.revision
  ) {
    return state;
  }

  switch (event.type) {
    case "reset": {
      const merged = mergeSessionState(event.state, state);
      return merged ? withEventRevision(merged, event) : merged;
    }
    case "state":
      if (!state) {
        return state;
      }
      return normalizeSessionState(
        withEventRevision(
          {
            ...state,
            ...event.state,
          },
          event,
        ),
      );
    case "assistant":
      if (!state) {
        return state;
      }
      return normalizeSessionState(
        withEventRevision({ ...state, activeAssistant: event.assistant }, event),
      );
    case "assistant-delta":
      if (!state) {
        return state;
      }
      return normalizeSessionState(
        withEventRevision(
          {
            ...state,
            activeAssistant: applyAssistantDelta(state.activeAssistant, event),
          },
          event,
        ),
      );
    case "tools":
      if (!state) {
        return state;
      }
      return normalizeSessionState(
        withEventRevision(
          { ...state, activeTools: mergeTools(state.activeTools, event.tools) },
          event,
        ),
      );
    case "tool-delta":
      if (!state) {
        return state;
      }
      return normalizeSessionState(
        withEventRevision(
          { ...state, activeTools: applyToolDelta(state.activeTools, event) },
          event,
        ),
      );
    case "status":
      if (!state) {
        return state;
      }
      return normalizeSessionState(
        withEventRevision(
          {
            ...state,
            isStreaming: event.isStreaming,
            pendingMessageCount: event.pendingMessageCount,
          },
          event,
        ),
      );
    case "error":
      return state;
    default:
      return state;
  }
}
