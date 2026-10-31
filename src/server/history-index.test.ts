import { expect, test } from "vite-plus/test";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { createHistoryIndex } from "./history-index";

test("50,000-entry archive uses transactional counts and indexed receipt/catch-up lookups", async () => {
  const db = await openNodeSqliteDatabase(":memory:");
  const storage = await SqliteStorage.open(db);
  const index = await createHistoryIndex(db);
  const started = performance.now();
  await db.transaction(async (tx) => {
    for (let id = 2; id < 50_002; id++) {
      await tx.run(
        "INSERT INTO entries (id, conversation_id, commit_seq, record) VALUES (?, 1, 1, ?)",
        id,
        JSON.stringify({
          id,
          conversationId: 1,
          kind: "pi.user",
          model: [{ role: "user", content: "original", timestamp: id }],
        }),
      );
    }
    for (let id = 50_002; id < 55_002; id++)
      await tx.run(
        "INSERT INTO entries (id, conversation_id, commit_seq, record) VALUES (?, 1, 1, ?)",
        id,
        JSON.stringify({ id, conversationId: 1, kind: "bookkeeping", data: {} }),
      );
    await tx.run(
      "INSERT INTO submissions VALUES (60000, 1, ?, 'done', ?)",
      JSON.stringify("client-id"),
      JSON.stringify({
        id: 60000,
        conversationId: 1,
        type: "input",
        status: "done",
        requestId: "client-id",
        entry: 49_999,
        answer: 50_000,
      }),
    );
  });
  const readStarted = performance.now();
  expect(await index.count(1)).toBe(50_000);
  expect(await index.clientIds(1, ["49999"])).toEqual(new Map([["49999", "client-id"]]));
  expect(await index.nextBoundary(1, "3", 120)).toEqual({ end: 123, more: true });
  const page = await index.entries(1, undefined, 120);
  expect(page.entries).toHaveLength(120);
  expect(page.entries.at(-1)!.id).toBe(50_001);
  expect(page.hasMoreMessages).toBe(true);
  const historyPlan = await db.all<{ detail: string }>(
    "EXPLAIN QUERY PLAN SELECT e.record FROM batty_entry_visibility v JOIN entries e ON e.id = v.id WHERE v.conversation_id = 1 AND v.visible_count > 0 ORDER BY v.id DESC LIMIT 121",
  );
  expect(historyPlan.some((row) => row.detail.includes("batty_visible_history"))).toBe(true);
  const plans = await db.all<{ detail: string }>(
    "EXPLAIN QUERY PLAN SELECT record FROM submissions WHERE conversation_id = 1 AND json_extract(record, '$.entry') IN (49999)",
  );
  expect(plans.some((row) => row.detail.includes("batty_submissions_by_entry"))).toBe(true);
  // Opening the read model again performs no archive scan/backfill.
  const reopened = await createHistoryIndex(db);
  expect(await reopened.count(1)).toBe(50_000);
  console.log(
    `history-index: 50,000 entries seeded in ${(readStarted - started).toFixed(0)}ms; indexed assertions/reopen ${(performance.now() - readStarted).toFixed(1)}ms`,
  );
  await storage.close(context);
});

test("indexed pagination and bounded catch-up retain archived messages across invisible entries", async () => {
  const db = await openNodeSqliteDatabase(":memory:");
  const storage = await SqliteStorage.open(db);
  const harness = await Harness.open(
    storage,
    { models: createModels(), registry: createRegistry() },
    context,
  );
  try {
    const main = await harness.root(context);
    const index = await createHistoryIndex(db);
    const ids: number[] = [];
    await main.commit(async (tx) => {
      for (let i = 0; i < 300; i++) {
        const entry = await tx.appendEntry(main.id, {
          kind: "pi.user",
          model: [{ role: "user", content: `message ${i}`, timestamp: i }],
        });
        ids.push(entry.id);
        await tx.appendEntry(main.id, { kind: "bookkeeping", data: { i } });
      }
      await tx.appendEntry(main.id, { kind: "archive-head", head: "self" });
    }, context);
    expect((await main.context(context)).messages).toHaveLength(0);
    const recent = await index.entries(main.id, undefined, 1);
    expect(recent.entries.map((entry) => entry.id)).toEqual([ids[299]]);
    const older = await index.entries(main.id, recent.nextBefore, 1);
    expect(older.entries.map((entry) => entry.id)).toEqual([ids[298]]);
    expect(older.hasMoreMessages).toBe(true);
    const oldest = await index.entries(main.id, String(ids[1]), 1);
    expect(oldest.entries.map((entry) => entry.id)).toEqual([ids[0]]);
    expect(oldest.hasMoreMessages).toBe(false);
    expect((await index.entries(main.id, oldest.nextBefore, 1)).entries).toEqual([]);

    let after = String(ids[20]);
    const caughtUp: number[] = [];
    for (;;) {
      const boundary = await index.nextBoundary(main.id, after, 120);
      const page = await index.entries(main.id, undefined, 120, after, boundary.end);
      caughtUp.push(...page.entries.map((entry) => entry.id));
      if (!boundary.more) break;
      after = String(boundary.end);
    }
    expect(caughtUp).toEqual(ids.slice(21));
  } finally {
    await harness.close(context);
  }
});

test("one-time backfill agrees with new commits and rolls back counts with failed archive writes", async () => {
  const db = await openNodeSqliteDatabase(":memory:");
  const storage = await SqliteStorage.open(db);
  const harness = await Harness.open(
    storage,
    { models: createModels(), registry: createRegistry() },
    context,
  );
  try {
    const main = await harness.root(context);
    const append = async () =>
      main.commit(async (tx) => {
        await tx.appendEntry(main.id, {
          kind: "pi.user",
          model: [{ role: "user", content: "one", timestamp: 1 }],
        });
        await tx.appendEntry(main.id, {
          kind: "hidden",
          model: [{ role: "system", content: "hidden", timestamp: 1 }],
        });
        await tx.appendEntry(main.id, { kind: "bookkeeping", data: {} });
        await tx.appendEntry(main.id, {
          kind: "custom",
          data: { original: { type: "custom_message", display: true } },
        });
      }, context);
    await append();
    const index = await createHistoryIndex(db);
    expect(await index.count(main.id)).toBe(2);
    await append();
    expect(await index.count(main.id)).toBe(4);
    await expect(
      db.transaction(async (tx) => {
        await tx.run(
          "INSERT INTO entries VALUES (90000, 1, NULL, 1, ?)",
          JSON.stringify({ model: [{ role: "user", content: "rolled back" }] }),
        );
        throw new Error("abort transaction");
      }),
    ).rejects.toThrow("abort transaction");
    expect(await index.count(main.id)).toBe(4);
  } finally {
    await harness.close(context);
  }
});
