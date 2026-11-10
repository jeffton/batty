import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vite-plus/test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { context, type Runtime } from "./runtime";
import { registerPushCompletions } from "./push-completions";
import type { WebPushService } from "./web-push";
import { suppressAgentCompletionNotification } from "@/shared/agent-notification";

test("committed replies notify without a session-event subscriber, excluding tools, workers and NO_REPLY", async () => {
  const directory = await mkdtemp(join(tmpdir(), "batty2-push-"));
  const models = createModels();
  const faux = fauxProvider({ models: [{ id: "test" }] });
  models.setProvider(faux.provider);
  const harness = await Harness.open(
    await openNodeSqliteStorage(join(directory, "runtime.sqlite")),
    { models, registry: createRegistry() },
    context,
  );
  try {
    const main = await harness.root(context, {
      agent: { model: { provider: "faux", modelId: "test" } },
    });
    const notifyAgentCompleted = vi.fn(async (state) => {
      if (!suppressAgentCompletionNotification(state)) delivered.push(state);
    });
    const delivered: Array<{ messages: Array<{ id: string }> }> = [];
    const reportError = vi.fn();
    const stop = registerPushCompletions(
      { harness, main, state: async () => ({ sessionId: String(main.id) }) } as unknown as Runtime,
      { notifyAgentCompleted } as unknown as WebPushService,
      reportError,
    );
    const append = async (conversationId: typeof main.id, text: string, stopReason = "stop") => {
      await main.commit(async (tx) => {
        await tx.appendEntry(conversationId, {
          kind: "pi.assistant",
          model: [fauxAssistantMessage(text, { stopReason: stopReason as "stop" })],
        });
      }, context);
    };
    await append(main.id, "Tool preamble", "toolUse");
    await append(main.id, "Provider failed", "error");
    await append(main.id, "Partial cancelled reply", "aborted");
    await append(main.id, "NO_REPLY");
    const worker = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await append(worker.id, "Worker reply");
    await append(main.id, "First final reply");
    await append(main.id, "Second final reply", "length");
    await vi.waitFor(() => expect(delivered).toHaveLength(2));
    expect(notifyAgentCompleted).toHaveBeenCalledTimes(3);
    expect(delivered[0]!.messages[0]!.id).not.toEqual(delivered[1]!.messages[0]!.id);
    expect(reportError).not.toHaveBeenCalled();
    stop();
  } finally {
    await harness.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});
