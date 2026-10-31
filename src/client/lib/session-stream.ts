import { withBaseUrl } from "@/client/lib/base-url";
import type { SessionState } from "@/shared/types";

export function sessionHistoryCursor(session: SessionState | undefined): string | undefined {
  const messageId = session?.messages.at(-1)?.id;
  if (session?.historyCursor === undefined) return messageId;
  return Number(messageId?.split(":")[0] ?? 0) > Number(session.historyCursor)
    ? messageId
    : session.historyCursor;
}
export function sessionEventsPath(session: Pick<SessionState, "id">, after?: string): string {
  return withBaseUrl(
    `/api/sessions/${encodeURIComponent(session.id)}/events${after ? `?after=${encodeURIComponent(after)}` : ""}`,
  );
}
