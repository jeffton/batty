import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createMemory, type MemoryConfig } from "./memory";

export const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

export async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "batty-memory-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  let compressions = 0;
  const open = async (options: Partial<MemoryConfig> = {}) => {
    const memory = createMemory(
      {
        nodeBytes: 80,
        viewBytes: 100,
        compress: async (source) => {
          compressions++;
          return `summary ${source.slice(0, 30)}`;
        },
        ...options,
      },
      models,
    );
    const registry = createRegistry();
    registry.install(memory.extension);
    const storage = await openNodeSqliteStorage(join(directory, "runtime.sqlite"));
    const harness = await Harness.open(
      storage,
      { models, registry, settings: { compaction: { enabled: false } } },
      context,
    );
    const main = await harness.root(context, {
      agent: { model: { provider: "faux", modelId: "faux-1" } },
    });
    await memory.bind(harness, main, storage);
    return { memory, harness, main, registry };
  };
  return { open, faux, models, compressions: () => compressions };
}
