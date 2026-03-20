export function workspaceEventsPath(workspaceId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/events`;
}
