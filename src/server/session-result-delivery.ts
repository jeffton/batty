import { BACKGROUND_CONTEXT as context, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { HarnessController } from "./harness-controller";

type DeliveryMessage = AgentMessage & { battyDelivery?: { id: string; part: number } };

/** Each native message is its own durable receipt, including a partially delivered result. */
export async function appendResultDelivery(
  session: HarnessController,
  deliveryId: string,
  messages: AgentMessage[],
): Promise<boolean> {
  let appended = false;
  // Callers serialize deliveries. Pi owns writes queued by a concurrent prompt admission.
  await session.waitForIdle();
  const entries = await session.sessionManager.native.findEntries({ order: "asc" }, context);
  const persisted = entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
  const queued = session.snapshot.queues.flatMap((entry) =>
    entry.type === "message" ? [entry.message] : [],
  );
  const delivered = new Set(
    [...persisted, ...queued].flatMap((message) => {
      const receipt = (message as DeliveryMessage).battyDelivery;
      return receipt?.id === deliveryId ? [receipt.part] : [];
    }),
  );
  for (const [part, message] of messages.entries()) {
    if (delivered.has(part)) continue;
    await session.lane.appendMessage(
      {
        ...message,
        battyDelivery: { id: deliveryId, part },
      } as DeliveryMessage,
      context,
    );
    appended = true;
  }
  return appended;
}
