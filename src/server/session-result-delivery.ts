import type { AgentSessionController } from "./agent-session-controller";
import type { SessionStore } from "./session-store";

const RESULT_DELIVERY_CUSTOM_TYPE = "batty-result-delivery";

export function hasDeliveredResult(session: AgentSessionController, replyId: string): boolean {
  return session.sessionManager.getEntries().some((entry) => {
    if (entry.type === "custom_message")
      return (
        (entry.details as { battyResultReplyId?: string } | undefined)?.battyResultReplyId ===
        replyId
      );
    if (entry.type !== "custom") return false;
    if (entry.customType === RESULT_DELIVERY_CUSTOM_TYPE)
      return (entry.data as { replyId: string }).replyId === replyId;
    return false;
  });
}

/** Callers serialize background deliveries; refresh the durable context after appending. */
export async function appendResultMessages(
  session: AgentSessionController,
  messages: Array<Parameters<SessionStore["appendMessage"]>[0]>,
  replyId?: string,
): Promise<boolean> {
  await session.waitForIdle();
  if (replyId && hasDeliveredResult(session, replyId)) return false;
  for (const message of messages) await session.sessionManager.appendMessage(message);
  if (replyId)
    await session.sessionManager.appendCustomEntry(RESULT_DELIVERY_CUSTOM_TYPE, { replyId });
  await session.refreshContext();
  return true;
}
