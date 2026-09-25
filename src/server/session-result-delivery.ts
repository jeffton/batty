import { BACKGROUND_CONTEXT as context, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { HarnessController } from "./harness-controller";

/** Callers serialize background deliveries; wait for any active parent turn to settle. */
export async function appendResultMessages(
  session: HarnessController,
  messages: AgentMessage[],
): Promise<void> {
  await session.waitForIdle();
  for (const message of messages) await session.lane.appendMessage(message, context);
}
