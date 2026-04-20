import { withBaseUrl } from "@/client/lib/base-url";

export function workspaceEventsPath(workspaceId: string): string {
  return withBaseUrl(`/api/workspaces/${encodeURIComponent(workspaceId)}/events`);
}
