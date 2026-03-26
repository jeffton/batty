import { toSessionSummary } from "@/client/lib/session-summary";
import type { SessionState, SessionSummary, WorkspaceInfo } from "@/shared/types";

export function uniqueWorkspaces(workspaces: WorkspaceInfo[]): WorkspaceInfo[] {
  const seenPaths = new Set<string>();

  return workspaces.filter((workspace) => {
    if (seenPaths.has(workspace.path)) {
      return false;
    }

    seenPaths.add(workspace.path);
    return true;
  });
}

function latestSessionUpdatedAt(
  workspaceId: string,
  sessionsByWorkspace: Record<string, SessionSummary[]>,
  activeSession?: SessionState,
): number | undefined {
  const latestWorkspaceSession = sessionsByWorkspace[workspaceId]?.[0]?.updatedAt;
  const activeSessionSummary =
    activeSession?.workspaceId === workspaceId && activeSession.path
      ? toSessionSummary(activeSession).updatedAt
      : undefined;

  if (latestWorkspaceSession == null) {
    return activeSessionSummary;
  }

  if (activeSessionSummary == null) {
    return latestWorkspaceSession;
  }

  return Math.max(latestWorkspaceSession, activeSessionSummary);
}

export function sortWorkspacesByRecentSession(
  workspaces: WorkspaceInfo[],
  sessionsByWorkspace: Record<string, SessionSummary[]>,
  activeSession?: SessionState,
): WorkspaceInfo[] {
  return [...workspaces].sort((left, right) => {
    const leftUpdatedAt = latestSessionUpdatedAt(left.id, sessionsByWorkspace, activeSession);
    const rightUpdatedAt = latestSessionUpdatedAt(right.id, sessionsByWorkspace, activeSession);

    if (leftUpdatedAt == null && rightUpdatedAt == null) {
      return left.label.localeCompare(right.label);
    }
    if (leftUpdatedAt == null) {
      return 1;
    }
    if (rightUpdatedAt == null) {
      return -1;
    }
    if (leftUpdatedAt !== rightUpdatedAt) {
      return rightUpdatedAt - leftUpdatedAt;
    }

    return left.label.localeCompare(right.label);
  });
}
