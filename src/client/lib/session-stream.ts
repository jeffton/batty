import type { SessionState } from "@/shared/types";

export function sessionHistoryCursor(session: SessionState | undefined): string | undefined {
  const messageId = session?.messages.at(-1)?.id;
  if (session?.historyCursor === undefined) return messageId;
  return Number(messageId?.split(":")[0] ?? 0) > Number(session.historyCursor)
    ? messageId
    : session.historyCursor;
}
