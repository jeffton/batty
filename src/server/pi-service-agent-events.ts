import type { SessionState } from "@/shared/types";
import type { SessionControllerEvent } from "./agent-session-controller";
import type { WebSession } from "./pi-service-types";

/** Host completion is receipt-aware and independent of browser frame delivery. */
export async function handleSessionEvent(
  deps: {
    getState: (sessionId: string) => SessionState;
    notifyWorkspaceUpdated: (workspaceId: string) => Promise<void>;
    disposeWebSession: (session: WebSession) => void;
    onAgentCompleted?: (session: SessionState) => Promise<void>;
    onAgentSettled?: (session: WebSession) => Promise<void>;
  },
  webSession: WebSession,
  event: SessionControllerEvent,
): Promise<void> {
  if (event.type === "run_start" || event.type === "compaction_start") {
    webSession.agentCompleted = false;
    await deps.notifyWorkspaceUpdated(webSession.workspace.id);
    return;
  }
  if (event.type !== "agent_settled" || webSession.agentCompleted) return;
  webSession.agentCompleted = true;
  const state = deps.getState(webSession.id);
  await deps.onAgentSettled?.(webSession);
  try {
    await deps.notifyWorkspaceUpdated(state.workspaceId);
  } catch (error) {
    console.error("Failed to publish workspace update", error);
  }
  try {
    await deps.onAgentCompleted?.(state);
  } catch (error) {
    console.error("Failed to run agent completion hook", error);
  }
  if (webSession.ephemeral && webSession.subscribers.size === 0) {
    deps.disposeWebSession(webSession);
  }
}
