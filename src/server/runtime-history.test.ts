import { expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { Harness, createRegistry, MemoryStorage } from "@earendil-works/pi-durable";
import { retainInput } from "./input-receipts";

test("withdrawn queued input has one immutable receipt after an idempotent retry", async () => {
  const storage = new MemoryStorage();
  const harness = await Harness.open(
    storage,
    { models: createModels(), registry: createRegistry() },
    context,
  );
  try {
    const main = await harness.root(context);
    const submissionId = await main.commit(
      async (tx) =>
        (
          await tx.createSubmission({
            conversationId: main.id,
            type: "input",
            status: "queued",
            requestId: "retry-id",
          })
        ).id,
      context,
    );
    await retainInput(main, submissionId, "never lose these words", "retry-id");
    await retainInput(main, submissionId, "never lose these words", "retry-id");
    await main.commit(
      (tx) => tx.settleSubmission(submissionId, { status: "unanswered", reason: "aborted" }),
      context,
    );
    const entries = await storage.scanEntries({ conversationId: main.id }, 20, undefined, context);
    const receipts = entries.items.filter((entry) => entry.kind === "batty.input-admitted");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.data).toMatchObject({
      content: "never lose these words",
      clientMessageId: "retry-id",
    });
  } finally {
    await harness.close(context);
  }
});
