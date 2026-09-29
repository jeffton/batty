import type { AgentSessionController } from "./agent-session-controller";
import type { SessionStore } from "./session-store";

/** Callers serialize background deliveries; refresh the SDK's authoritative context after appending. */
export async function appendResultMessages(
  session: AgentSessionController,
  messages: Array<Parameters<SessionStore["appendMessage"]>[0]>,
): Promise<void> {
  await session.waitForIdle();
  for (const message of messages) await session.sessionManager.appendMessage(message);
  session.sdk.refreshContext();
}
