import { expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { COMPACT_PROMPT, createMemory } from "./memory.js";

test("leaf and merge requests contain only their own sources, never the preceding overview", async () => {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  const originals = Array.from(
    { length: 4 },
    (_, i) => `unrelated-${i}: ${"original source detail ".repeat(12).trim()}`,
  );
  const sources: string[] = [];
  const summaries: string[] = [];
  faux.setResponses(
    Array.from({ length: 20 }, () => (request) => {
      expect(request.messages).toHaveLength(2);
      expect(request.messages[0]).toMatchObject({ role: "system", content: COMPACT_PROMPT });
      const user = request.messages[1]!;
      expect(user.role).toBe("user");
      const content = user.content as string;
      const prefix = `Compress this message or merge these two child lines into one line of at most 80 UTF-8 bytes. The following ruler is 80 ASCII bytes long; non-ASCII text needs more bytes per character:\n${"-".repeat(80)}\nUse only the source below:\n<input>\n`;
      expect(content.startsWith(prefix)).toBe(true);
      expect(content.endsWith("\n</input>")).toBe(true);
      const source = content.slice(prefix.length, -"\n</input>".length);
      sources.push(source);
      // Each leaf has exactly its own original; each merge has exactly two
      // earlier child outputs. No other overview, examples or messages enter.
      if (source.startsWith("user: unrelated-")) {
        expect(originals.map((text) => `user: ${text}`)).toContain(source);
        expect(originals.filter((text) => source.includes(text))).toHaveLength(1);
      } else {
        const children = source.split("\n");
        expect(children).toHaveLength(2);
        for (const child of children) expect(summaries).toContain(child);
        expect(source).not.toContain("unrelated-");
      }
      const summary = `echo: child-${summaries.length} ${"x".repeat(40)}`;
      summaries.push(summary);
      return fauxAssistantMessage([fauxText(summary)]);
    }),
  );
  const memory = createMemory(
    { memoryModel: "faux/faux-1", nodeBytes: 80, viewBytes: 100 },
    models,
  );
  const registry = createRegistry();
  registry.install(memory.extension);
  const storage = new MemoryStorage();
  const harness = await Harness.open(
    storage,
    { models, registry, settings: { compaction: { enabled: false } } },
    context,
  );
  try {
    const main = await harness.root(context, {
      agent: { model: { provider: "faux", modelId: "faux-1" } },
    });
    await main.commit(async (tx) => {
      for (const [i, text] of originals.entries()) {
        await tx.appendEntry(main.id, {
          kind: "pi.user",
          model: [{ role: "user", content: text, timestamp: i + 1 }],
        });
      }
    }, context);
    await memory.bind(harness, main, storage);
    const overview = await memory.prepare();
    expect(sources.filter((source) => source.startsWith("user: unrelated-"))).toHaveLength(4);
    expect(sources.some((source) => source.includes("\n"))).toBe(true);
    expect(overview).not.toContain("not summarized");
    for (const [i, text] of originals.entries()) {
      expect(await memory.zoom(i, 1)).toBe(`${i}+0|user: ${text}`);
      expect(await memory.date(i)).toBe(new Date(i + 1).toISOString());
    }
    const calls = sources.length;
    expect(await memory.prepare()).toBe(overview);
    expect(sources).toHaveLength(calls);
    expect(await memory.zoom(0, 2)).toContain("1+1|");
  } finally {
    await harness.close(context);
    await memory.close();
  }
});
