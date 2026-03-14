export function workspaceRoutePath(workspaceId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}`;
}

export function sessionRoutePath(workspaceId: string, sessionId: string): string {
  return `${workspaceRoutePath(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`;
}
