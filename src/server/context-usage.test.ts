import { expect, test } from "vite-plus/test";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createHistoryIndex } from "./history-index";

test("context uses the last request, including cached tokens, independently of history paging", async () => {
  const db = await openNodeSqliteDatabase(":memory:");
  const storage = await SqliteStorage.open(db);
  try {
    const index = await createHistoryIndex(db);
    const model = { provider: "openai-codex", id: "gpt-6.1-terra", contextWindow: 500_000 };
    let id = 0;
    const append = async (messages: unknown[]) =>
      db.run(
        "INSERT INTO entries (id, conversation_id, commit_seq, record) VALUES (?, 1, 1, ?)",
        ++id,
        JSON.stringify({ model: messages }),
      );
    const response = (usage: Record<string, number>, overrides = {}) => ({
      role: "assistant",
      provider: model.provider,
      model: model.id,
      stopReason: "stop",
      content: [{ type: "text", text: "answer" }],
      timestamp: id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, ...usage },
      ...overrides,
    });
    expect((await index.contextUsage(1, model)).contextTokens).toBeNull();
    await append([response({ input: 241, cacheRead: 152_704, output: 24, reasoning: 12 })]);
    for (let i = 0; i < 130; i++) await append([{ role: "user", content: "new input" }]);
    expect(await index.contextUsage(1, model)).toEqual({
      contextTokens: 152_945,
      contextPercent: 30.589,
    });
    // A continuation is a fresh prompt measurement, not an addition to the
    // previous prompt. Cached input is already normalized by the provider SDK.
    await append([response({ input: 0, cacheRead: 160_000, output: 2000 })]);
    expect((await index.contextUsage(1, model)).contextTokens).toBe(160_000);
    expect(
      (await index.contextUsage(1, { ...model, id: "another-model" })).contextTokens,
    ).toBeNull();
    await append([response({ input: 0 }, { stopReason: "error" })]);
    expect((await index.contextUsage(1, model)).contextTokens).toBeNull();
    // Anthropic's normalized input, cache writes and reads are disjoint too;
    // reasoning is part of output, not an additional prompt-token category.
    const anthropic = { provider: "anthropic", id: "claude", contextWindow: 200_000 };
    await append([
      response(
        { input: 1000, cacheRead: 30_000, cacheWrite: 9000, output: 5000, reasoning: 4000 },
        { provider: anthropic.provider, model: anthropic.id },
      ),
    ]);
    expect(await index.contextUsage(1, anthropic)).toEqual({
      contextTokens: 40_000,
      contextPercent: 20,
    });
    expect((await index.contextUsage(1, model)).contextTokens).toBeNull();
    await append([response({ input: 0, output: 0 })]);
    expect((await index.contextUsage(1, model)).contextTokens).toBeNull();
    const plan = await db.all<{ detail: string }>(`EXPLAIN QUERY PLAN
      SELECT record FROM entries e WHERE e.conversation_id = 1 AND EXISTS (
        SELECT 1 FROM json_each(json_extract(e.record, '$.model')) m
        WHERE json_extract(m.value, '$.role') = 'assistant') ORDER BY e.id DESC LIMIT 1`);
    expect(plan.some((row) => row.detail.includes("entries_by_conversation"))).toBe(true);
    expect(plan.some((row) => row.detail.includes("TEMP B-TREE"))).toBe(false);
  } finally {
    await storage.close(context);
  }
});
