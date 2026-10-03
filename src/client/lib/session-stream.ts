import { withBaseUrl } from "@/client/lib/base-url";
import type { SessionState } from "@/shared/types";

export function sessionEventsPath(
  session: Pick<SessionState, "id" | "workspaceId" | "path">,
  messagesDetailLevel: "summary" | "full" = "summary",
): string {
  const params = new URLSearchParams({ workspaceId: session.workspaceId });
  if (session.path) params.set("sessionPath", session.path);
  if (messagesDetailLevel === "full") params.set("messagesDetailLevel", messagesDetailLevel);
  return withBaseUrl(`/api/sessions/${encodeURIComponent(session.id)}/events?${params}`);
}
