import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createMemory, type MemoryLeaf } from "./memory";
import { createMemorySearch } from "./memory-search";
import { MAIN_MEMORY_TOOLS, withoutMainMemory } from "./main-memory-policy";

const leaf = (text: string, kind: MemoryLeaf["kind"] = "user"): MemoryLeaf => ({
  text,
  kind,
  date: "2026-05-01T10:00:00.000Z",
  source: 42,
  ordinal: 0,
});

test("FTS backfill checkpoints survive reopen, filter noise/tools, preserve original IDs and bound common queries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "batty-search-"));
  let db = await openNodeSqliteDatabase(join(dir, "runtime.sqlite"));
  try {
    let search = await createMemorySearch(db);
    await search.append(1, 0, [
      leaf("Malin pension compensation"),
      leaf("NO_REPLY", "talk"),
      leaf("pension tool diagnostic", "echo"),
      leaf("Runtime subagent: [subagent 123 result] NO_REPLY", "note"),
      leaf("Runtime cron: [cron 124 result] pension report", "note"),
    ]);
    expect(await search.cursor(1)).toBe(5);
    expect((await search.search(1, { query: "pension" })).map((x) => x.id)).toEqual([4, 0]);
    expect(
      (await search.search(1, { query: "pension", includeTools: true })).map((x) => x.id),
    ).toEqual([4, 2, 0]);
    expect(await search.search(1, { query: "NO_REPLY", includeTools: true })).toEqual([]);
    await search.append(2, 0, [leaf("pension other workspace")]);
    expect(await search.search(1, { query: "pension" })).toHaveLength(2);
    await db.close();
    db = await openNodeSqliteDatabase(join(dir, "runtime.sqlite"));
    search = await createMemorySearch(db);
    expect(await search.cursor(1)).toBe(5);
    await expect(search.append(1, 0, [leaf("duplicate")])).rejects.toThrow("checkpoint");
    for (let start = 5; start < 10005; start += 128)
      await search.append(
        1,
        start,
        Array.from({ length: Math.min(128, 10005 - start) }, () =>
          leaf("common history " + "x".repeat(2000)),
        ),
      );
    const started = performance.now();
    const result = await search.search(1, { query: "common", limit: 20 });
    expect(result).toHaveLength(20);
    expect(result[0]!.id).toBe(10004);
    expect(result.every((x) => x.snippet.length <= 800)).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(await search.search(1, { query: "compensation Malin" })).toMatchObject([
      { id: 0, kind: "user", date: leaf("").date },
    ]);
    await expect(search.search(1, { query: "x".repeat(257) })).rejects.toThrow("256");
    await expect(search.search(1, { query: "a", limit: 21 })).rejects.toThrow("1–20");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("memory lifecycle indexes original history and new entries with zoom IDs; tool enforces worker boundary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "batty-search-runtime-"));
  const db = await openNodeSqliteDatabase(join(dir, "runtime.sqlite"));
  const storage = await SqliteStorage.open(db);
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  const memory = createMemory(
    { nodeBytes: 32, compress: async () => "user: topic omitted" },
    models,
  );
  const registry = createRegistry();
  registry.install(memory.extension);
  const harness = await Harness.open(storage, { models, registry }, context);
  const main = await harness.root(context, {
    agent: { model: { provider: "faux", modelId: "faux-1" } },
  });
  try {
    await main.commit(
      (tx) =>
        tx.appendEntry(main.id, {
          kind: "pi.user",
          model: [
            {
              role: "user",
              content: "Forgotten Barcelona pension conversation with original detail",
              timestamp: 1000,
            },
          ],
        }),
      context,
    );
    await memory.bind(harness, main, storage, await createMemorySearch(db));
    await memory.prepare();
    const found = await memory.search({ query: "Barcelona pension" });
    expect(found).toMatchObject([{ id: 0, kind: "user", date: "1970-01-01T00:00:01.000Z" }]);
    expect(await memory.zoom(found[0]!.id, 1)).toContain("original detail");
    await main.commit(
      (tx) =>
        tx.appendEntry(main.id, {
          kind: "pi.user",
          model: [{ role: "user", content: "New pension decision", timestamp: 2000 }],
        }),
      context,
    );
    expect((await memory.search({ query: "pension" })).map((x) => x.id)).toEqual([1, 0]);
    const tool = memory.extension.tools!.find((x) => x.name === "memory_search")!;
    const api = (id: typeof main.id, workspaceId: string) =>
      ({ conversationId: id, snapshot: async () => ({ workspaceId }) }) as unknown as Parameters<
        typeof tool.execute
      >[1];
    const child = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await expect(
      tool.execute({ query: "pension" }, api(child.id, "other"), context),
    ).rejects.toThrow("only to Roy");
    const result = await tool.execute({ query: "pension" }, api(child.id, "roy"), context);
    expect(result.output).toMatchObject([
      { type: "text", text: expect.stringContaining("New [pension] decision") },
    ]);
    expect(MAIN_MEMORY_TOOLS.has("memory_search")).toBe(true);
    expect(
      withoutMainMemory([
        {
          role: "toolResult",
          toolName: "memory_search",
          toolCallId: "search",
          content: result.output!,
          isError: false,
          timestamp: 1,
        },
      ]),
    ).toEqual([]);
  } finally {
    await memory.close();
    await harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
});
