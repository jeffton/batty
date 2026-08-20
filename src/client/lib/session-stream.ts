import { withBaseUrl } from "@/client/lib/base-url";
import type { SessionState } from "@/shared/types";

export function sessionEventsPath(
  session: Pick<SessionState, "id" | "workspaceId" | "path" | "revision">,
  messagesDetailLevel: "summary" | "full" = "summary",
): string {
  const params = new URLSearchParams();
  params.set("workspaceId", session.workspaceId);
  if (typeof session.revision === "number") {
    params.set("afterRevision", String(session.revision));
  }
  if (session.path) {
    params.set("sessionPath", session.path);
  }
  if (messagesDetailLevel === "full") {
    params.set("messagesDetailLevel", messagesDetailLevel);
  }

  const query = params.toString();
  return withBaseUrl(
    `/api/sessions/${encodeURIComponent(session.id)}/events${query ? `?${query}` : ""}`,
  );
}
