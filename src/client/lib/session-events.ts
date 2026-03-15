import { mergeSessionState, normalizeSessionState } from "@/client/lib/session-state";
import type { ActiveToolRun, ServerEvent, SessionState } from "@/shared/types";

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
  switch (event.type) {
    case "state":
      return mergeSessionState(event.state, state);
    case "assistant":
      if (!state) {
        return state;
      }
      return normalizeSessionState({
        ...state,
        activeAssistant: event.assistant,
      });
    case "tools":
      if (!state) {
        return state;
      }
      return normalizeSessionState({
        ...state,
        activeTools: mergeTools(state.activeTools, event.tools),
      });
    case "status":
      if (!state) {
        return state;
      }
      return normalizeSessionState({
        ...state,
        isStreaming: event.isStreaming,
        pendingMessageCount: event.pendingMessageCount,
      });
    case "error":
      return state;
    default:
      return state;
  }
}
