import type { SessionSummary, WorkspaceInfo } from "@/shared/types";

export type WorkspaceSearchMatch = "workspace" | "session";

export function workspaceMatchesQuery(workspace: WorkspaceInfo, query: string): boolean {
  return `${workspace.label} ${workspace.path}`.toLowerCase().includes(query);
}

export function matchingSessions(
  sessions: SessionSummary[],
  query: string,
  sessionLabel: (session: SessionSummary) => string,
): SessionSummary[] {
  return sessions.filter((session) => sessionLabel(session).toLowerCase().includes(query));
}

export function sessionsForWorkspaceSearch(
  workspace: WorkspaceInfo | undefined,
  sessions: SessionSummary[],
  query: string,
  sessionLabel: (session: SessionSummary) => string,
): SessionSummary[] {
  return workspace && workspaceMatchesQuery(workspace, query)
    ? sessions
    : matchingSessions(sessions, query, sessionLabel);
}

export function workspaceSearchMatch(
  workspace: WorkspaceInfo,
  sessions: SessionSummary[],
  query: string,
  sessionLabel: (session: SessionSummary) => string,
): WorkspaceSearchMatch | undefined {
  if (workspaceMatchesQuery(workspace, query)) {
    return "workspace";
  }

  return matchingSessions(sessions, query, sessionLabel).length > 0 ? "session" : undefined;
}
