import type { Conversation } from "@earendil-works/pi-durable";
import { DeliveryRecord } from "./orchestration-history";
import { encodeRuntimeNotice } from "./runtime-notices";
import { context } from "./runtime";

export function publishSystemNotification(main: Conversation, id: string, text: string) {
  return main.commit(async (tx) => {
    const receipt = await tx.doc(DeliveryRecord, `system:${id}`, {});
    if (receipt.directDelivered) return { published: false };
    await tx.appendEntry(main.id, {
      kind: "batty.system-notification",
      model: [
        {
          role: "user",
          content: encodeRuntimeNotice({
            kind: "system",
            text: `System notification already delivered to the user; do not resend.\n${text}`,
            data: { directDelivery: { text } },
          }),
          timestamp: Date.now(),
        },
      ],
    });
    receipt.directDelivered = true;
    return { published: true };
  }, context);
}
