import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createMemory } from "./memory";
import { createMemorySearch } from "./memory-search";
import { buildBaseOptions } from "@earendil-works/pi-ai/api/simple-options";

test("optional recall uses spare context space without changing the overview or aborting a valid large input", async () => {
  const dir = await mkdtemp(join(tmpdir(), "batty-recall-budget-"));
  const db = await openNodeSqliteDatabase(join(dir, "runtime.sqlite"));
  const storage = await SqliteStorage.open(db);
  const models = createModels();
  const faux = fauxProvider({ models: [{ id: "faux-1", contextWindow: 10000, maxTokens: 256 }] });
  models.setProvider(faux.provider);
  const memory = createMemory(
    {
      sessionTailBytes: 1,
      nodeBytes: 60,
      viewBytes: 200,
      compress: async () => "user: archived conversation",
    },
    models,
  );
  const registry = createRegistry();
  registry.install(memory.extension);
  const harness = await Harness.open(storage, { models, registry }, context);
  const main = await harness.root(context, {
    agent: { model: { provider: "faux", modelId: "faux-1" } },
  });
  try {
    await main.commit(async (tx) => {
      for (let i = 0; i < 80; i++)
        await tx.appendEntry(main.id, {
          kind: "pi.user",
          model: [
            {
              role: "user",
              content:
                i < 12 ? `brønd ${i} ${"loremipsum ".repeat(300)}` : "ordinary historical content",
              timestamp: i + 1,
            },
          ],
        });
    }, context);
    const search = await createMemorySearch(db);
    await memory.bind(harness, main, storage, search);
    const originalView = await memory.prepare();
    const full = await search.recall(Number(main.id), "brønden", [], 80, new Set());
    expect(full.text.length).toBeGreaterThan(2000);
    const input = `brønden ${"x".repeat(14500)}`;
    let sent!: Parameters<typeof buildBaseOptions>[1];
    faux.setResponses([
      (request) => {
        sent = request;
        return fauxAssistantMessage([fauxText("done")]);
      },
    ]);
    expect(
      (await (await main.submit({ type: "input", content: input }, context)).wait(context)).status,
    ).toBe("done");
    expect(buildBaseOptions(models.getModel("faux", "faux-1")!, sent).maxTokens).toBe(256);
    const users = sent.messages.filter((message) => message.role === "user");
    expect(String(users[0]?.content).split("\n<!--")[0]).toBe(originalView);
    expect(users.at(-1)?.content).toBe(input);
    const recall = String(
      users.find((message) => String(message.content).startsWith("<memory-recall>"))?.content ?? "",
    );
    expect(recall.length).toBeLessThan(full.text.length);
  } finally {
    await memory.close();
    await harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
});
