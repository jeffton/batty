import fastify from "fastify";
import { expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createMemory } from "./memory";
import { registerMemoryTreeRoutes } from "./routes/memory-tree";
import { createAuthToken, verifyAuthToken } from "./auth";

test("authenticated prepared tree traverses to exact leaves without writes or model calls", async () => {
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
  const app = fastify();
  app.decorateRequest("auth", false);
  app.addHook("onRequest", async (request) => {
    request.auth = verifyAuthToken("test-secret", request.headers.authorization);
  });
  registerMemoryTreeRoutes(app, memory);
  const headers = { authorization: createAuthToken("test-secret") };
  let writes = 0;
  const observation = harness.observeCommits({
    advance: () => {
      writes++;
    },
    end: () => {},
  });
  const before = compressions;
  try {
    for (const url of ["/api/memory/tree", "/api/memory/tree/0/1"]) {
      expect((await app.inject({ url })).statusCode).toBe(401);
      expect((await app.inject({ url, headers: { authorization: "invalid" } })).statusCode).toBe(
        401,
      );
    }
    const repairRequest = {
      method: "POST" as const,
      url: "/api/memory/tree/repair",
      payload: { generation: 0, roots: [{ start: 0, count: 2 }], dryRun: true },
    };
    expect((await app.inject(repairRequest)).statusCode).toBe(401);
    const plan = await app.inject({ ...repairRequest, headers });
    expect(plan.statusCode).toBe(200);
    expect(plan.json().nodes).toEqual([
      { start: 0, count: 2 },
      { start: 0, count: 4 },
      { start: 0, count: 8 },
    ]);
    for (const payload of [
      {},
      { ...repairRequest.payload, generation: 2 },
      { ...repairRequest.payload, roots: [{ start: 1, count: 2 }] },
      { ...repairRequest.payload, roots: [] },
    ])
      expect((await app.inject({ ...repairRequest, headers, payload })).statusCode).toBe(400);
    const response = await app.inject({ url: "/api/memory/tree", headers });
    expect(response.headers["cache-control"]).toBe("no-store");
    const overview = response.json();
    expect(overview.prepared).toBe(8);
    expect(overview.nodes[0].count).toBeGreaterThan(1);
    let node = overview.nodes[0];
    while (node.count > 1) {
      const result = (
        await app.inject({ url: `/api/memory/tree/${node.id}/${node.count}`, headers })
      ).json();
      expect(result.children).toHaveLength(2);
      expect(result.children[0].count).toBe(node.count / 2);
      expect(result.children[1].id).toBe(node.id + node.count / 2);
      node = result.children[0];
    }
    const leaf = (await app.inject({ url: `/api/memory/tree/${node.id}/1`, headers })).json();
    expect(leaf.text).toBe(await memory.zoom(node.id, 1));
    expect(leaf.text).toContain("original 0");
    for (const range of ["-1/1", "1/2", "0/3", "0/0", "8/1", "0/16", "x/2", "0/9007199254740992"]) {
      expect((await app.inject({ url: `/api/memory/tree/${range}`, headers })).statusCode).toBe(
        400,
      );
    }
    expect(
      (await app.inject({ method: "POST", url: "/api/memory/tree", headers })).statusCode,
    ).toBe(404);
    expect(writes).toBe(0);
    expect(compressions).toBe(before);
  } finally {
    observation.detach();
    await app.close();
    await memory.close();
    await harness.close(context);
  }
});
