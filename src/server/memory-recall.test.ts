import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  Harness,
  defineExtension,
  hook,
  GenerationTask,
} from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createMemory, type MemoryLeaf } from "./memory";
import { createMemorySearch } from "./memory-search";
import type { Message } from "@earendil-works/pi-ai";
import { decodeRuntimeNotice, encodeRuntimeNotice } from "./runtime-notices";
import { MemoryRecall } from "./memory-documents";

const leaf = (text: string): MemoryLeaf => ({
  text,
  kind: "user",
  date: "2026-01-01T00:00:00Z",
  source: 1,
  ordinal: 0,
});

test("language-independent variants are bidirectional, exact-first, conjunctive and conservative for short words/identifiers", async () => {
  const db = await openNodeSqliteDatabase(":memory:");
  try {
    const search = await createMemorySearch(db);
    await search.append(1, 0, [
      leaf("brønd vand"),
      leaf("brønden vand"),
      leaf("brønden " + "vand ".repeat(30)),
      leaf("Fur"),
      leaf("furious"),
      leaf("cF2_code"),
      leaf("cF2_codes"),
      leaf("brønden tør"),
      leaf("Αθήνα"),
      leaf("नमस्ते"),
      leaf("Århus"),
    ]);
    expect((await search.search(1, { query: "brønd" })).map((hit) => hit.id)[0]).toBe(0);
    expect((await search.search(1, { query: "brønden" })).map((hit) => hit.id)).toContain(0);
    expect((await search.search(1, { query: "brønd vand" })).map((hit) => hit.id)).toEqual(
      expect.arrayContaining([0, 1, 2]),
    );
    expect((await search.search(1, { query: "brønd vand" })).map((hit) => hit.id)).not.toContain(7);
    expect((await search.search(1, { query: "Fur" })).map((hit) => hit.id)).toEqual([3]);
    expect((await search.search(1, { query: "cF2_code" })).map((hit) => hit.id)).toEqual([5]);
    expect((await search.search(1, { query: "brønden" })).at(-1)?.id).toBe(0);
    expect((await search.search(1, { query: "Αθήνα" })).map((hit) => hit.id)).toEqual([8]);
    expect((await search.search(1, { query: "नमस्ते" })).map((hit) => hit.id)).toEqual([9]);
    expect((await search.search(1, { query: "Arhus" })).map((hit) => hit.id)).toEqual([10]);
    await search.append(2, 0, [leaf("brønd private")]);
    expect(await search.search(1, { query: "private" })).toEqual([]);
  } finally {
    await db.close();
  }
});

test("recall keeps source IDs without automatic neighbors, excludes visible/recent duplicates and handles empty retrieval", async () => {
  const db = await openNodeSqliteDatabase(":memory:");
  try {
    const search = await createMemorySearch(db);
    await search.append(1, 0, [
      leaf("Vi er i Fur, det svenske Fur"),
      leaf("Altså i og ikke på 😅"),
      ...Array.from({ length: 80 }, () => leaf("almindelig historik fyldtekst")),
    ]);
    const found = await search.recall(1, "Fur", [], 82, new Set());
    expect(found.terms).toEqual(["fur"]);
    expect(found.text).toContain("0+1|");
    expect(found.text).not.toContain("1+1|");
    expect(found.text).not.toContain("Altså i og ikke på");
    expect(await search.recall(1, "Fur", [], 82, new Set([0, 1]))).toMatchObject({ text: "" });
    expect(await search.recall(1, "Fur", [], 10, new Set())).toMatchObject({ text: "" });
    expect(await search.recall(1, "unknowntopic", [], 82, new Set())).toMatchObject({
      terms: [],
      text: "",
    });
    expect(await search.recall(1, "😅", [], 82, new Set())).toMatchObject({ terms: [], text: "" });
    expect((await search.recall(1, "fortæl", ["Fur"], 82, new Set())).text).toContain("0+1|");
    const wall = await search.recall(
      1,
      "Fur almindelig historik fyldtekst ".repeat(2000),
      ["brønd"],
      82,
      new Set(),
    );
    expect(wall.terms.length).toBeLessThanOrEqual(32);
  } finally {
    await db.close();
  }
});

test("recall finds unseen inflections in either direction and does not learn keywords from the active input or other conversations", async () => {
  const db = await openNodeSqliteDatabase(":memory:");
  try {
    const search = await createMemorySearch(db);
    for (const [conversation, spelling, query] of [
      [1, "brønd", "brønden"],
      [2, "brønden", "brønd"],
    ] as const) {
      await search.append(conversation, 0, [
        leaf(spelling),
        ...Array.from({ length: 80 }, () => leaf("ordinary repeated history")),
        leaf(`${query} unknownunique`),
      ]);
      const result = await search.recall(conversation, `${query} unknownunique`, [], 82, new Set());
      expect(result.terms).toEqual([query]);
      expect(result.text).toContain(`user: ${spelling}`);
    }
    expect(await search.recall(3, "brønden unknownunique", [], 82, new Set())).toEqual({
      terms: [],
      text: "",
    });
  } finally {
    await db.close();
  }
});

test("automatic OR recall ranks topic variants alongside exact matches instead of exhausting weaker exact hits", async () => {
  const db = await openNodeSqliteDatabase(":memory:");
  try {
    const search = await createMemorySearch(db);
    await search.append(1, 0, [
      ...Array.from({ length: 20 }, () => leaf("topicwarm old")),
      ...Array.from({ length: 20 }, () => leaf("brønden water")),
      ...Array.from({ length: 1000 }, () => leaf("ordinary repeated history")),
    ]);
    const result = await search.recall(1, "topicwarm brønd", [], 1040, new Set());
    expect(result.terms).toHaveLength(2);
    expect(result.text).toContain("brønden water");
  } finally {
    await db.close();
  }
});

test("recall retains common topic words and separates previous topics", async () => {
  const db = await openNodeSqliteDatabase(":memory:");
  try {
    const search = await createMemorySearch(db);
    await search.append(1, 0, [
      leaf("Bought the sensor bracket in aluminium"),
      leaf("Unrelated adjacent private information"),
      ...Array.from({ length: 180 }, (_, i) => leaf(`bracket ordinary document ${i}`)),
      ...Array.from({ length: 120 }, (_, i) => leaf(`astonishing detail ${i}`)),
      ...Array.from({ length: 40 }, (_, i) => leaf(`previousrare contexttopic detail ${i}`)),
      ...Array.from({ length: 1000 }, () => leaf("ordinary repeated history")),
    ]);
    const result = await search.recall(
      1,
      "An astonishing sensor bracket",
      ["previousrare contexttopic"],
      1342,
      new Set(),
    );
    expect(result.terms).toContain("bracket");
    expect(result.text).toContain("Bought the sensor bracket");
    expect(result.text).not.toMatch(/\n1\+1\|/);
    expect(result.text).toContain("previousrare contexttopic");
    const onlyCurrent = await search.recall(1, "sensor bracket", [], 1342, new Set());
    expect(onlyCurrent.text).toContain("Bought the sensor bracket");
    expect(onlyCurrent.text).not.toContain("previousrare contexttopic");
    expect((await search.recall(2, "sensor bracket", [], 1342, new Set())).text).toBe("");
  } finally {
    await db.close();
  }
});

test("recall reaches older sources beyond twenty already-visible hits", async () => {
  const db = await openNodeSqliteDatabase(":memory:");
  try {
    const search = await createMemorySearch(db);
    await search.append(1, 0, [
      leaf("telescope original purchase"),
      ...Array.from({ length: 70 }, (_, i) => leaf(`telescope recent detail ${i}`)),
      ...Array.from({ length: 80 }, () => leaf("ordinary repeated history")),
    ]);
    const result = await search.recall(
      1,
      "telescope",
      [],
      151,
      new Set(Array.from({ length: 70 }, (_, i) => i + 1)),
    );
    expect(result.text).toContain("telescope original purchase");
  } finally {
    await db.close();
  }
});

test("recall preserves a multi-term excerpt when individual queries find distant words", async () => {
  const db = await openNodeSqliteDatabase(":memory:");
  try {
    const search = await createMemorySearch(db);
    await search.append(1, 0, [
      leaf(
        "astonishing bracket bought for the bicycle " + "unrelated passage ".repeat(100) + "sensor",
      ),
      ...Array.from({ length: 80 }, () => leaf("ordinary repeated history")),
    ]);
    const result = await search.recall(1, "astonishing sensor bracket", [], 81, new Set());
    expect(result.text).toContain("bought for the bicycle");
    expect(result.text).toContain("zoom for full text");
  } finally {
    await db.close();
  }
});

test("main injects zoomable source recall immediately before input, preserving the overview and tool-continuation cache prefix", async () => {
  const dir = await mkdtemp(join(tmpdir(), "batty-recall-"));
  const db = await openNodeSqliteDatabase(join(dir, "runtime.sqlite"));
  const storage = await SqliteStorage.open(db);
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  const memory = createMemory(
    { nodeBytes: 60, viewBytes: 200, compress: async () => "user: archived conversation" },
    models,
  );
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "render-runtime-notices",
      hooks: [
        hook(GenerationTask, {
          beforeRequest: ({ messages }) => ({
            messages: messages.map((message) => {
              const notice = message.role === "user" && decodeRuntimeNotice(message.content);
              return notice ? ({ ...message, content: notice.text } as Message) : message;
            }),
          }),
        }),
      ],
    }),
  );
  registry.install(memory.extension);
  const harness = await Harness.open(
    storage,
    { models, registry, settings: { steeringMode: "all" } },
    context,
  );
  const main = await harness.root(context, {
    agent: { model: { provider: "faux", modelId: "faux-1" } },
  });
  let closed = false;
  try {
    await main.commit(async (tx) => {
      for (const [i, text] of [
        "Vi er i Fur, det svenske Fur",
        "Altså i og ikke på 😅",
        ...Array.from({ length: 80 }, () => "almindelig historik fyldtekst"),
      ].entries())
        await tx.appendEntry(main.id, {
          kind: "pi.user",
          model: [{ role: "user", content: text, timestamp: i + 1 }],
        });
    }, context);
    await memory.bind(harness, main, storage, await createMemorySearch(db));
    await memory.prepare();
    const requests: Message[][] = [];
    faux.setResponses([
      async (request) => {
        requests.push([...request.messages]);
        await main.submit({ type: "input", content: "Fur igen", whenBusy: "steer" }, context);
        await main.submit(
          {
            type: "input",
            content: encodeRuntimeNotice({ kind: "subagent", text: "Fur report" }),
            whenBusy: "steer",
          },
          context,
        );
        return fauxAssistantMessage([fauxToolCall("memory_search", { query: "Fur" })], {
          stopReason: "toolUse",
        });
      },
      (request) => {
        requests.push([...request.messages]);
        return fauxAssistantMessage([fauxText("done")]);
      },
    ]);
    expect(
      (await (await main.submit({ type: "input", content: "Fur" }, context)).wait(context)).status,
    ).toBe("done");
    expect(requests).toHaveLength(2);
    const first = requests[0]!.filter((message) => message.role !== "system");
    const second = requests[1]!.filter((message) => message.role !== "system");
    expect(first.at(-1)).toMatchObject({ role: "user", content: "Fur" });
    expect(first.at(-2)?.content).toContain("<memory-recall>");
    expect(first.at(-2)?.content).toContain("0+1|");
    expect(first.at(-2)?.content).not.toContain("Altså i og ikke på");
    // The estimator timestamp is intentionally refreshed; provider prompt content stays identical.
    const cacheContent = (messages: Message[]) =>
      messages.map((message) => ({ ...message, timestamp: 0 }));
    expect(cacheContent(second.slice(0, first.length))).toEqual(cacheContent(first));
    expect(await memory.zoom(1, 1)).toContain("Altså i og ikke på");
    expect(await memory.search({ query: "recall" })).toEqual([]);
    expect(first[0]?.content).not.toContain("memory-recall");
    const users = second.filter((message) => message.role === "user");
    expect(
      users.filter((message) => String(message.content).startsWith("<memory-recall>")).length,
    ).toBe(2);
    expect(users.at(-2)?.content).toBe("Fur igen");
    expect(users.at(-1)?.content).toBe("Fur report");
    // Pinned inputs survive a real SQLite/harness reopen.
    const original = first.at(-1)!;
    const key = createHash("sha256")
      .update(JSON.stringify([original.timestamp, original.content]))
      .digest("hex");
    await memory.close();
    await harness.close(context);
    closed = true;
    const reopened = await Harness.open(
      await SqliteStorage.open(await openNodeSqliteDatabase(join(dir, "runtime.sqlite"))),
      { models, registry: createRegistry() },
      context,
    );
    try {
      const root = await reopened.root(context);
      expect((await reopened.snapshot(MemoryRecall, root.id, key, context))?.text).toBe(
        first.at(-2)?.content,
      );
    } finally {
      await reopened.close(context);
    }
  } finally {
    if (!closed) {
      await memory.close();
      await harness.close(context);
    }
    await rm(dir, { recursive: true, force: true });
  }
});
