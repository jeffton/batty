import { expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createMemory } from "./memory";
import { createOwnerRpcHandler, type OwnerRpcServices } from "./owner-rpc";
import type { Runtime } from "./runtime";

test("native prepared tree traverses to exact leaves without writes or model calls", async () => {
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  let compressions = 0;
  const memory = createMemory(
    {
      viewBytes: 40,
      compress: async () => {
        compressions++;
        return "user: summary";
      },
    },
    models,
  );
  const registry = createRegistry();
  registry.install(memory.extension);
  const storage = new MemoryStorage();
  const harness = await Harness.open(storage, { models, registry }, context);
  const main = await harness.root(context, {
    agent: { model: { provider: "faux", modelId: "faux-1" } },
  });
  await main.commit(async (tx) => {
    for (let i = 0; i < 8; i++)
      await tx.appendEntry(main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: `original ${i} ${"x".repeat(600)}`, timestamp: i + 1 }],
      });
  }, context);
  await memory.bind(harness, main, storage);
  await memory.prepare();
  const handler = createOwnerRpcHandler(
    { config: {}, tools: {}, memory } as unknown as Runtime,
    {} as OwnerRpcServices,
  );
  const call = async (name: string, input: object = {}) =>
    (await handler(name, input, { signal: new AbortController().signal })).value;
  let writes = 0;
  const observation = harness.observeCommits({
    advance: () => {
      writes++;
    },
    end: () => {},
  });
  const before = compressions;
  try {
    const repairRequest = { generation: 0, roots: [{ start: 0, count: 2 }], dryRun: true };
    const plan = (await call("memory.repair", repairRequest)) as Awaited<
      ReturnType<typeof memory.repair>
    >;
    expect(plan.nodes).toEqual([
      { start: 0, count: 2 },
      { start: 0, count: 4 },
      { start: 0, count: 8 },
    ]);
    for (const payload of [
      {},
      { ...repairRequest, generation: 2 },
      { ...repairRequest, roots: [{ start: 1, count: 2 }] },
      { ...repairRequest, roots: [] },
    ])
      await expect(call("memory.repair", payload)).rejects.toMatchObject({ code: "BAD_INPUT" });
    const overview = (await call("memory.tree")) as Awaited<
      ReturnType<typeof memory.browserOverview>
    >;
    expect(overview.prepared).toBe(8);
    expect(overview.nodes[0]!.count).toBeGreaterThan(1);
    let node = overview.nodes[0]!;
    while (node.count > 1) {
      const result = (await call("memory.expand", { id: node.id, count: node.count })) as Awaited<
        ReturnType<typeof memory.browserNode>
      >;
      expect(result.children).toHaveLength(2);
      expect(result.children![0]!.count).toBe(node.count / 2);
      expect(result.children![1]!.id).toBe(node.id + node.count / 2);
      node = result.children![0]!;
    }
    const leaf = (await call("memory.expand", { id: node.id, count: 1 })) as { text: string };
    expect(leaf.text).toBe(await memory.zoom(node.id, 1));
    expect(leaf.text).toContain("original 0");
    for (const range of ["-1/1", "1/2", "0/3", "0/0", "8/1", "0/16", "x/2", "0/9007199254740992"]) {
      const [id, count] = range.split("/").map(Number);
      await expect(call("memory.expand", { id, count })).rejects.toMatchObject({
        code: "BAD_INPUT",
      });
    }
    expect(writes).toBe(0);
    expect(compressions).toBe(before);
  } finally {
    observation.detach();
    await memory.close();
    await harness.close(context);
  }
});
