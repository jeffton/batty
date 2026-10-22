import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineDocFamily, Harness, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  createMemory,
  MemoryIndexDoc,
  MemoryMaintenanceDoc,
  MemoryNodesDoc,
  type MemoryLeaf,
} from "./memory";

const Leaves = defineDocFamily<MemoryLeaf, MemoryLeaf>({
  kind: "batty.memory-leaf",
  checkpointWhen: () => false,
  version: 1,
  family: true,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: (value) => value,
});

test("large disk tree has bounded startup, cold zoom cache and incremental restart work", async () => {
  const dir = await mkdtemp(join(tmpdir(), "batty-memory-scaling-"));
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  const count = 16384;
  let reads = 0;
  let summaries = 0;
  const open = async () => {
    const storage: Storage = await openNodeSqliteStorage(join(dir, "runtime.sqlite"));
    const find = storage.findDocument.bind(storage);
    storage.findDocument = (...args) => {
      if (args[0].kind.startsWith("batty.memory-")) reads++;
      return find(...args);
    };
    const memory = createMemory(
      {
        nodeBytes: 512,
        viewBytes: 128000,
        compress: async () => {
          summaries++;
          return "user: merged";
        },
      },
      models,
    );
    const registry = createRegistry();
    registry.install(memory.extension);
    const harness = await Harness.open(storage, { models, registry }, context);
    const main = await harness.root(context, {
      agent: { model: { provider: "faux", modelId: "faux-1" } },
    });
    return { storage, memory, harness, main };
  };
  let state = await open();
  try {
    // Seed an already summarized archive, as on production restart. Each batch
    // remains bounded even while preparing the fixture's durable documents.
    for (let start = 0; start < count; start += 128) {
      await state.main.commit(async (tx) => {
        for (let id = start; id < Math.min(start + 128, count); id++) {
          await tx.doc(Leaves, state.main.id, String(id), {
            kind: "user",
            text: `${id} ${"x".repeat(1024)}`,
            date: new Date(id + 1).toISOString(),
            source: 0,
            ordinal: 0,
          });
          await tx.doc(MemoryNodesDoc, state.main.id, `${id}+1`, { text: `user: ${id}` });
          for (let size = 2; (id + 1) % size === 0; size *= 2)
            await tx.doc(MemoryNodesDoc, state.main.id, `${id + 1 - size}+${size}`, {
              text: "user: merged",
            });
        }
      }, context);
      await (state.harness as Harness & { unloadDocuments(): Promise<void> }).unloadDocuments();
    }
    await state.main.commit(async (tx) => {
      Object.assign(await tx.doc(MemoryIndexDoc, state.main.id), {
        count,
        cursor: 0,
        viewCount: count,
        parts: [{ start: 0, count }],
        generation: 0,
      });
      Object.assign(await tx.doc(MemoryMaintenanceDoc, state.main.id), {
        generation: 0,
        settled: count,
      });
    }, context);
    reads = 0;
    const started = performance.now();
    await state.memory.bind(state.harness, state.main, state.storage);
    await state.memory.prepare();
    const startupReads = reads;
    expect(startupReads).toBeLessThan(10);
    expect(summaries).toBe(0);
    const startupMs = performance.now() - started;
    for (let id = 0; id < 4096; id++)
      expect(await state.memory.zoom(id, 1)).toContain(`user: ${id} `);
    expect(state.memory.status().cacheBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    // The first branch was evicted, but remains available from durable storage.
    expect(await state.memory.zoom(0, 1)).toContain("user: 0 ");
    const observed: number[] = [];
    const watch = (await state.harness.watchDoc(MemoryIndexDoc, state.main.id, context))!;
    watch.start(async (value) => {
      if (value) observed.push(value.count);
    });
    const before = reads;
    await state.main.commit(
      (tx) =>
        tx.appendEntry(state.main.id, {
          kind: "pi.user",
          model: [{ role: "user", content: "new decision", timestamp: count + 1 }],
        }),
      context,
    );
    await state.memory.prepare();
    expect(reads - before).toBeLessThan(20);
    expect(await state.memory.zoom(count, 1)).toContain("new decision");
    const appendReads = reads - before;
    const growthStart = performance.now();
    const growthBefore = reads;
    await state.main.commit(async (tx) => {
      for (let id = 0; id < 70; id++)
        await tx.appendEntry(state.main.id, {
          kind: "pi.user",
          model: [{ role: "user", content: `tail ${id}`, timestamp: count + id + 2 }],
        });
    }, context);
    await state.memory.prepare();
    expect(reads - growthBefore).toBeLessThan(500);
    expect(observed).toContain(count + 71);
    await watch.stop();
    const metrics = {
      leaves: count,
      startupMs,
      startupReads,
      appendReads,
      growthLeaves: 70,
      growthReads: reads - growthBefore,
      growthMs: performance.now() - growthStart,
      cacheBytes: state.memory.status().cacheBytes,
    };
    if (process.env.BATTY_SCALING_REPORT)
      await writeFile(process.env.BATTY_SCALING_REPORT, JSON.stringify(metrics));
    await state.memory.close();
    await state.harness.close(context);
    state = await open();
    reads = 0;
    await state.memory.bind(state.harness, state.main, state.storage);
    await state.memory.prepare();
    expect(reads).toBeLessThan(80);
    expect(state.memory.status().settled).toBe(count + 71);
    expect(await state.memory.zoom(count, 1)).toContain("new decision");
    expect(await state.memory.zoom(count + 70, 1)).toContain("tail 69");
  } finally {
    await state.memory.close();
    await state.harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
}, 60000);
