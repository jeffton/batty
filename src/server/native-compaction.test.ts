import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, type Conversation } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createMemory } from "./memory.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "batty-native-compaction-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const models = createModels();
  const faux = fauxProvider({
    models: [
      { id: "tiny", contextWindow: 256, maxTokens: 64 },
      { id: "main", contextWindow: 32_000, maxTokens: 4096 },
    ],
  });
  models.setProvider(faux.provider);
  const requests: string[] = [];
  let summaries = 0;
  const respond = (request: Parameters<typeof models.streamSimple>[1]) => {
    const text = JSON.stringify(request.messages);
    requests.push(text);
    if (text.includes("You are a context summarization assistant")) {
      summaries++;
      return fauxAssistantMessage("Native worker checkpoint");
    }
    return fauxAssistantMessage("Done");
  };
  faux.setResponses(Array.from({ length: 20 }, () => respond));
  const open = async () => {
    const memory = createMemory({ nodeBytes: 100_000, viewBytes: 200_000 }, models);
    const registry = createRegistry();
    registry.install(memory.extension);
    const storage = await openNodeSqliteStorage(join(directory, "runtime.sqlite"));
    const harness = await Harness.open(
      storage,
      {
        models,
        registry,
        settings: {
          compaction: {
            enabled: true,
            reserveTokens: 64,
            keepRecentTokens: 32,
            backgroundTokens: 0,
          },
        },
      },
      context,
    );
    const main = await harness.root(context, {
      agent: { model: { provider: "faux", modelId: "tiny" } },
    });
    await memory.bind(harness, main, storage);
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await harness.close(context);
      await memory.close();
    };
    cleanup.push(close);
    return { harness, main, close };
  };
  return { open, requests, summaries: () => summaries };
}

async function seed(conversation: Conversation) {
  return conversation.commit(async (tx) => {
    const ids = [];
    for (let index = 0; index < 4; index++) {
      const entry = await tx.appendEntry(conversation.id, {
        kind: "pi.user",
        model: [
          {
            role: "user",
            content: `Original ${index}: ${"history ".repeat(150)}`,
            timestamp: index + 1,
          },
        ],
      });
      ids.push(entry.id);
    }
    return ids;
  }, context);
}

async function submit(conversation: Conversation, content: string) {
  const settled = await (
    await conversation.submit({ type: "input", content }, context)
  ).wait(context);
  expect(settled.status).toBe("done");
}

test("non-root workers compact natively and preserve original storage across restart", async () => {
  const fixtureState = await fixture();
  let state = await fixtureState.open();
  const workers = [];
  // Subagent, fresh cron and detached cron all execute in non-root conversations.
  for (const role of ["subagent", "fresh cron", "detached cron"]) {
    const worker = await state.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: { provider: "faux", modelId: "tiny" } },
      },
      context,
    );
    const originals = await seed(worker);
    await submit(worker, role);
    const active = await worker.context(context);
    expect(active.head?.kind).toBe("pi.compaction");
    expect(JSON.stringify(active.messages)).toContain("Native worker checkpoint");
    expect(active.entries.some((entry) => entry.id === originals[0])).toBe(false);
    const stored = (await worker.entries({}, 100, undefined, context)).items;
    expect(originals.every((id) => stored.some((entry) => entry.id === id))).toBe(true);
    workers.push({ id: worker.id, originals, head: active.head });
  }
  expect(fixtureState.summaries()).toBe(3);
  await state.close();
  state = await fixtureState.open();
  for (const saved of workers) {
    const worker = (await state.harness.conversation(saved.id, context))!;
    expect((await worker.context(context)).head).toEqual(saved.head);
    const stored = (await worker.entries({}, 100, undefined, context)).items;
    expect(saved.originals.every((id) => stored.some((entry) => entry.id === id))).toBe(true);
    await submit(worker, "Continue after restart");
  }
});

test("main declines native summaries and retains OptChat run heads", async () => {
  const fixtureState = await fixture();
  const { main, harness } = await fixtureState.open();
  await main.configure({ model: { provider: "faux", modelId: "main" } }, context);
  for (const input of ["Main input"]) {
    const originals = await seed(main);
    await harness.waitForTask(await main.compact(undefined, context), context);
    await submit(main, input);
    const active = await main.context(context);
    expect(active.head?.kind).toBe("batty.run-head");
    const stored = (await main.entries({}, 100, undefined, context)).items;
    expect(stored.some((entry) => entry.kind === "pi.compaction")).toBe(false);
    expect(originals.every((id) => stored.some((entry) => entry.id === id))).toBe(true);
  }
  const tasks = await main.commit(
    (tx) => tx.scanTasks({ conversationId: main.id, kind: "pi.compaction" }, 100),
    context,
  );
  expect(tasks.items).toHaveLength(1);
  for (const task of tasks.items) {
    expect(task.state).toMatchObject({
      status: "terminal",
      outcome: { status: "completed", result: {} },
    });
  }
  expect(fixtureState.summaries()).toBe(0);
  expect(fixtureState.requests).toHaveLength(1);
  expect(fixtureState.requests.every((request) => request.includes("<chat>"))).toBe(true);
  expect(fixtureState.requests.every((request) => request.includes("batty-optchat:"))).toBe(true);
});
