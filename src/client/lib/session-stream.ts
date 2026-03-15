import type { SessionState } from "@/shared/types";

export function sessionEventsPath(
  session: Pick<SessionState, "id" | "workspaceId" | "path">,
): string {
  const params = new URLSearchParams();
  params.set("workspaceId", session.workspaceId);
  if (session.path) {
    params.set("sessionPath", session.path);
  }

  const query = params.toString();
  return `/api/sessions/${encodeURIComponent(session.id)}/events${query ? `?${query}` : ""}`;
}
