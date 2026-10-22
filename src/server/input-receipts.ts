import {
  defineDocFamily,
  type Conversation,
  type SubmissionId,
  type UserInput,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonObject } from "@earendil-works/pi-durable";

const InputReceipt = defineDocFamily<{ entryId: number }, { entryId: number }>({
  kind: "batty.input-receipt",
  checkpointWhen: () => false,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  family: true,
  initial: (value) => value,
});

/** Accepted input remains immutable even if withdrawn before Pi places it. */
export async function retainInput(
  main: Conversation,
  submissionId: SubmissionId,
  content: UserInput,
  clientMessageId?: string,
): Promise<void> {
  await main.commit(async (tx) => {
    const receipt = await tx.doc(InputReceipt, main.id, String(submissionId), { entryId: 0 });
    if (receipt.entryId) return;
    const entry = await tx.appendEntry(main.id, {
      kind: "batty.input-admitted",
      data: {
        submissionId,
        content,
        timestamp: Date.now(),
        ...(clientMessageId ? { clientMessageId } : {}),
      } as JsonObject,
    });
    receipt.entryId = entry.id;
  }, BACKGROUND_CONTEXT);
}
