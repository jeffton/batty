import { expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { MemoryNodesDoc, MemoryMaintenanceDoc, MemoryIndexDoc } from "./memory-documents";
import { fixture, cleanup } from "./memory-test-fixture";

test("selective repair stages ancestors atomically, preserves siblings and originals, and serializes new nodes", async () => {
  const f = await fixture();
  const sources: string[] = [];
  let entered!: () => void;
  let resume!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const state = await f.open({
    nodeBytes: 512,
    compress: async (source) => {
      sources.push(source);
      if (sources.length === 1) {
        entered();
        await blocked;
      }
      return `user: Dansk reparation ${sources.length}`;
    },
  });
  cleanup.push(() => state.harness.close(context));
  await state.main.commit(async (tx) => {
    for (let i = 0; i < 8; i++)
      await tx.appendEntry(state.main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: `Original ${i}`, timestamp: i + 1 }],
      });
  }, context);
  await state.memory.prepare();
  const node = (key: string) => state.harness.snapshot(MemoryNodesDoc, state.main.id, key, context);
  const sibling = await node("4+4");
  const original = await state.memory.zoom(0, 1);
  const plan = await state.memory.repair([{ start: 0, count: 2 }], 0, true);
  expect(plan.nodes).toEqual([
    { start: 0, count: 2 },
    { start: 0, count: 4 },
    { start: 0, count: 8 },
  ]);
  expect(sources).toEqual([]);
  const before = await node("0+2");
  const repairing = state.memory.repair([{ start: 0, count: 2 }], 0);
  await started;
  expect(await node("0+2")).toEqual(before);
  await state.main.commit(
    (tx) =>
      tx.appendEntry(state.main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "Ny original", timestamp: 20 }],
      }),
    context,
  );
  const preparing = state.memory.prepare();
  resume();
  const result = await repairing;
  await preparing;
  expect(result.nodes).toHaveLength(3);
  expect(sources[1]).toContain("Dansk reparation 1");
  expect(sources[2]).toContain("Dansk reparation 2");
  expect(await node("4+4")).toEqual(sibling);
  expect(await state.memory.zoom(0, 1)).toBe(original);
  expect(await state.memory.zoom(8, 1)).toContain("Ny original");
  expect(state.memory.status().totalLeaves).toBe(9);
  await expect(state.memory.repair([{ start: 1, count: 2 }], 0)).rejects.toThrow(
    "Invalid repair root",
  );
  await expect(state.memory.repair([{ start: 0, count: 2 }], 1)).rejects.toThrow(
    "generation changed",
  );
});

test("selective repair refuses concurrent edits without publishing partial ancestors", async () => {
  const f = await fixture();
  let entered!: () => void;
  let resume!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const state = await f.open({
    nodeBytes: 512,
    compress: async () => {
      entered();
      await blocked;
      return "user: Dansk reparation";
    },
  });
  cleanup.push(() => state.harness.close(context));
  await state.main.commit(async (tx) => {
    for (let i = 0; i < 4; i++)
      await tx.appendEntry(state.main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: `Original ${i}`, timestamp: i + 1 }],
      });
  }, context);
  await state.memory.prepare();
  const before = await state.harness.snapshot(MemoryNodesDoc, state.main.id, "0+4", context);
  const repair = state.memory.repair([{ start: 0, count: 2 }], 0);
  await started;
  await state.main.commit(async (tx) => {
    (await tx.doc(MemoryNodesDoc, state.main.id, "0+2", { text: "" })).text = "Concurrent edit";
  }, context);
  resume();
  await expect(repair).rejects.toThrow("Memory node changed during repair");
  expect(await state.harness.snapshot(MemoryNodesDoc, state.main.id, "0+4", context)).toEqual(
    before,
  );
  expect((await state.harness.snapshot(MemoryNodesDoc, state.main.id, "0+2", context))?.text).toBe(
    "Concurrent edit",
  );
});

test("generation-two repair deduplicates overlapping roots without touching older generations", async () => {
  const f = await fixture();
  let state = await f.open({ nodeBytes: 512 });
  await state.main.commit(async (tx) => {
    for (let i = 0; i < 8; i++)
      await tx.appendEntry(state.main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: `Original ${i}`, timestamp: i + 1 }],
      });
  }, context);
  await state.memory.prepare();
  const originals = await Promise.all(
    Array.from({ length: 8 }, (_, id) => state.memory.zoom(id, 1)),
  );
  const old = await state.harness.snapshot(MemoryNodesDoc, state.main.id, "0+8", context);
  const copies: { key: string; text: string }[] = [];
  for (let count = 1; count <= 8; count *= 2)
    for (let start = 0; start + count <= 8; start += count)
      copies.push({
        key: `g2:${start}+${count}`,
        text: (await state.harness.snapshot(
          MemoryNodesDoc,
          state.main.id,
          `${start}+${count}`,
          context,
        ))!.text,
      });
  await state.main.commit(async (tx) => {
    for (const { key, text } of copies) await tx.doc(MemoryNodesDoc, state.main.id, key, { text });
    (await tx.doc(MemoryIndexDoc, state.main.id)).generation = 2;
    (await tx.doc(MemoryMaintenanceDoc, state.main.id)).generation = 2;
  }, context);
  await state.harness.close(context);
  state = await f.open({ nodeBytes: 512, compress: async () => "user: Dansk reparation" });
  cleanup.push(() => state.harness.close(context));
  const sibling = await state.harness.snapshot(MemoryNodesDoc, state.main.id, "g2:0+4", context);
  const repaired = await state.memory.repair(
    [
      { start: 6, count: 2 },
      { start: 4, count: 4 },
    ],
    2,
  );
  expect(repaired.nodes.map(({ start, count }) => `${start}+${count}`)).toEqual([
    "6+2",
    "4+4",
    "0+8",
  ]);
  expect(await state.harness.snapshot(MemoryNodesDoc, state.main.id, "g2:0+4", context)).toEqual(
    sibling,
  );
  expect(await state.harness.snapshot(MemoryNodesDoc, state.main.id, "0+8", context)).toEqual(old);
  expect(await Promise.all(Array.from({ length: 8 }, (_, id) => state.memory.zoom(id, 1)))).toEqual(
    originals,
  );
});

test("language repair explicitly translates inherited foreign prose without changing originals", async () => {
  const f = await fixture();
  const state = await f.open({
    nodeBytes: 512,
    compress: undefined,
    memoryModel: "faux/faux-1",
    memoryLanguage: "Danish",
  });
  cleanup.push(() => state.harness.close(context));
  await state.main.commit(async (tx) => {
    for (let i = 0; i < 2; i++)
      await tx.appendEntry(state.main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "Valde altan; resten uppskjutet.", timestamp: i + 1 }],
      });
  }, context);
  await state.memory.prepare();
  f.faux.setResponses([
    (request) => {
      expect(JSON.stringify(request.messages)).toContain(
        "Translate ALL unquoted summary prose into Danish",
      );
      expect(JSON.stringify(request.messages)).toContain("Valde altan; resten uppskjutet.");
      return fauxAssistantMessage([fauxText("user: Valgte altan; resten udskudt.")]);
    },
  ]);
  await state.memory.repair([{ start: 0, count: 2 }], 0);
  expect((await state.harness.snapshot(MemoryNodesDoc, state.main.id, "0+2", context))?.text).toBe(
    "user: Valgte altan; resten udskudt.",
  );
  expect(await state.memory.zoom(0, 1)).toContain("Valde altan; resten uppskjutet.");
});
