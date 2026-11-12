import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, type Conversation } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createMemorySearch } from "./memory-search";
import { createMemory } from "./memory";
import { WorkerMemory } from "./memory-documents";
import { isMainMemoryView, withoutMainMemory } from "./main-memory-policy";
import { snapshotFromView, workerMemoryView } from "./memory-snapshot";
import { cleanup } from "./memory-test-fixture";

const image = {
  type: "image" as const,
  mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBzQAAAAASUVORK5CYII=",
};
const task = "Execute heartbeat; source collection is complete, write the journal once";

test("legacy projection retains complete prepared lines containing literal chat tags", () => {
  const tree =
    "<chat>\n0+2|summary mentions </chat> as source text\n2+2|later prepared decision\n</chat>";
  const snapshot = { generation: 2, count: 57, prepared: 4 };
  const view = workerMemoryView(
    `${tree}\n<unprepared-main-memory>\nlegacy raw payload\n</unprepared-main-memory>`,
    snapshot,
  );
  expect(view).toContain(tree);
  expect(view).not.toContain("legacy raw payload");
  expect(view).toContain("Main messages 4–56");
  expect(snapshotFromView(view)).toEqual(snapshot);
});

// Real memory indexing/compression, native generation hooks and durable SQLite pins.
// Compression can lag behind ingestion without a rejected/mocked memory helper.
async function fixture(options: { native?: boolean; largeOverview?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "batty-worker-admission-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const models = createModels();
  const faux = fauxProvider({
    models: [
      { id: "main", contextWindow: 2_000_000, maxTokens: 1024 },
      { id: "luna", contextWindow: 272_000, maxTokens: 1024 },
      { id: "small", contextWindow: 128_000, maxTokens: 1024 },
      { id: "tiny", contextWindow: 16_000, maxTokens: 1024 },
    ],
  });
  models.setProvider(faux.provider);
  let hold = false;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  cleanup.push(async () => release());
  const open = async () => {
    const memory = createMemory(
      {
        nodeBytes: options.largeOverview ? 2_000_000 : 80,
        viewBytes: options.largeOverview ? 2_000_000 : 160,
        compress: async (source) => {
          if (hold) await ready;
          return source.includes("FUTURE MAIN DECISION")
            ? "FUTURE MAIN DECISION"
            : "retained archive decision";
        },
      },
      models,
    );
    const registry = createRegistry();
    registry.install(memory.extension);
    const db = await openNodeSqliteDatabase(join(directory, "runtime.sqlite"));
    const storage = await SqliteStorage.open(db);
    const search = await createMemorySearch(db);
    const harness = await Harness.open(
      storage,
      {
        models,
        registry,
        settings: {
          compaction: {
            enabled: options.native ?? false,
            reserveTokens: 1024,
            keepRecentTokens: 128,
            backgroundTokens: 0,
          },
        },
      },
      context,
    );
    const main = await harness.root(context, {
      agent: { model: { provider: "faux", modelId: "main" } },
    });
    await memory.bind(harness, main, storage, search);
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      release();
      await harness.close(context);
      await memory.close();
    };
    cleanup.push(close);
    return { memory, main, harness, close };
  };
  return {
    open,
    models,
    faux,
    hold: () => {
      hold = true;
    },
    release,
  };
}

async function append(conversation: Conversation, messages: Message[]) {
  await conversation.commit(
    (tx) => tx.appendEntry(conversation.id, { kind: "pi.user", model: messages }),
    context,
  );
}

type MemoryState = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["open"]>>;

async function workerFor(state: MemoryState, model = "small") {
  return state.harness.createConversation(
    { ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: model } } },
    context,
  );
}

async function submit(worker: Conversation, content = task) {
  const result = await (await worker.submit({ type: "input", content }, context)).wait(context);
  const last = (await worker.context(context)).messages.at(-1);
  expect(result.status, JSON.stringify({ result, last })).toBe("done");
}

function background(messages: readonly Message[]) {
  const backgrounds = messages.filter(isMainMemoryView);
  expect(backgrounds).toHaveLength(1);
  const message = backgrounds[0]!;
  expect(message.role).toBe("user");
  if (message.role !== "user" || !Array.isArray(message.content))
    throw new Error("Missing worker background blocks");
  return {
    message,
    blocks: message.content,
    text: message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n"),
  };
}

async function seedPending(
  state: MemoryState,
  f: Awaited<ReturnType<typeof fixture>>,
  characters = 612_000,
) {
  await append(state.main, [
    { role: "user", content: "Archived family decision ".repeat(20), timestamp: 1 },
    { role: "user", content: "Archived project decision ".repeat(20), timestamp: 2 },
  ]);
  await state.memory.prepare();
  f.hold();
  const original = `needle-pending-original\n${"artifact:file:0123456789abcdef ".repeat(Math.ceil(characters / 53 / 29))}`;
  await append(
    state.main,
    Array.from({ length: 53 }, (_, index): Message => ({
      role: "user",
      timestamp: index + 3,
      content: index === 0 ? [{ type: "text", text: original }, image] : `${index}: ${original}`,
    })),
  );
  await state.memory.sync();
  expect(state.memory.status().totalLeaves).toBe(55);
  expect(state.memory.status().builtLeaves).toBe(2);
  return original;
}

test.each([false, true])(
  "oversized pending memory is addressable across tool rounds, including a legacy raw pin (%s)",
  async (legacy) => {
    const f = await fixture();
    const state = await f.open();
    const original = await seedPending(state, f);
    const worker = await workerFor(state);
    if (legacy) {
      // This is the previously persisted representation, not a new compact packet.
      const raw = original.repeat(54).slice(0, 612_000);
      const framing = `<chat>\n0+2|retained archive decision\n</chat>\n<unprepared-main-memory>\n${raw}\n</unprepared-main-memory>\n<!-- batty-optchat:{"generation":0,"count":55,"prepared":2} -->`;
      const view = framing.replace(
        "retained archive decision",
        `retained archive decision${" prepared history".repeat(10_000).slice(0, 723_000 - framing.length)}`,
      );
      expect(view.length).toBe(723_000);
      await worker.commit(
        async (tx) =>
          Object.assign(await tx.doc(WorkerMemory, worker.id), {
            view,
            snapshot: { generation: 0, count: 55, prepared: 2 },
            attachments: [image],
          }),
        context,
      );
    }
    // Seed actual durable provider accounting for the obsolete oversized prefix.
    const previous = fauxAssistantMessage("Previous heartbeat progress: sources collected", {
      timestamp: 1000,
    });
    previous.usage = { ...previous.usage, input: 337_000, output: 10, totalTokens: 337_010 };
    await append(worker, [previous]);
    let requests = 0;
    const responses = [
      fauxToolCall("memory_search", { query: "needle-pending-original" }),
      fauxToolCall("memory_zoom", { id: 2, n: 1 }),
      fauxToolCall("memory_zoom", { id: 54, n: 1 }),
    ];
    f.faux.setResponses(
      Array.from({ length: 4 }, (_, round) => (request) => {
        requests++;
        const packet = background(request.messages);
        expect(packet.text).toContain("retained archive decision");
        expect(packet.text).toContain("Main messages 2–54");
        expect(packet.text).toContain("memory_zoom(id, 1)");
        expect(packet.text).not.toContain("needle-pending-original");
        expect(packet.text).not.toContain("artifact:file:0123456789abcdef");
        expect(packet.blocks.some((part) => part.type === "image")).toBe(false);
        expect(withoutMainMemory(request.messages)).not.toContain(packet.message);
        expect(packet.message.timestamp).toBeGreaterThan(
          Math.max(...withoutMainMemory(request.messages).map((message) => message.timestamp)),
        );
        expect(
          request.messages.some((message) => message.role === "user" && message.content === task),
        ).toBe(true);
        expect(clampMaxTokensToContext(f.models.getModel("faux", "small")!, request, 1024)).toBe(
          1024,
        );
        expect(request.messages).toContainEqual(previous);
        const results = request.messages.filter((message) => message.role === "toolResult");
        if (round >= 1) {
          expect(results[0]).toMatchObject({ toolName: "memory_search", isError: false });
          const result = results[0]!;
          const text = result.content.find((part) => part.type === "text")!;
          if (text.type !== "text") throw new Error("Missing search results");
          expect(JSON.parse(text.text)).toContainEqual(expect.objectContaining({ id: 54 }));
          expect(text.text).toContain("[needle]-[pending]-[original]");
        }
        if (round >= 2) {
          expect(results[1]).toMatchObject({ toolName: "memory_zoom", isError: false });
          expect(results[1]!.content).toContainEqual(image);
          expect(JSON.stringify(results[1])).toContain(original.replaceAll("\n", "\\n"));
        }
        if (round === 3) {
          expect(results).toHaveLength(3);
          expect(results[2]).toMatchObject({ toolName: "memory_zoom", isError: false });
          expect(JSON.stringify(results[2])).toContain("54+0|");
        }
        const response = fauxAssistantMessage(
          round < 3 ? [responses[round]!] : [fauxText("journal written once")],
          { stopReason: round < 3 ? "toolUse" : "stop" },
        );
        return response;
      }),
    );
    await submit(worker);
    expect(requests).toBe(4);
    const stored = await state.harness.snapshot(WorkerMemory, worker.id, context);
    expect(stored?.snapshot).toMatchObject({ count: 55, prepared: 2 });
    expect(stored?.view).not.toContain("needle-pending-original");
    expect(stored?.view).not.toContain("artifact:file:0123456789abcdef");
    const entries = (await worker.entries({}, 100, undefined, context)).items;
    expect(entries.some((entry) => entry.kind === "pi.compaction")).toBe(false);
    expect(await state.memory.zoom(2, 1)).toContain(original);
    f.release();
  },
);

test("workers on either selected model use prepared history and pending locators, not raw originals", async () => {
  const f = await fixture();
  const state = await f.open();
  await seedPending(state, f);
  for (const model of ["luna", "small"]) {
    const worker = await workerFor(state, model);
    f.faux.setResponses([
      (request) => {
        const packet = background(request.messages);
        expect(packet.text).not.toContain("needle-pending-original");
        expect(packet.text).not.toContain("artifact:file:0123456789abcdef");
        expect(packet.text).toContain("Main messages 2–54");
        expect(packet.text).toContain("retained archive decision");
        expect(packet.blocks.filter((part) => part.type === "image")).toEqual([]);
        expect(clampMaxTokensToContext(f.models.getModel("faux", model)!, request, 1024)).toBe(
          1024,
        );
        return fauxAssistantMessage("complete");
      },
    ]);
    await submit(worker);
  }
  f.release();
});

test("large pending originals remain addressable without entering the request", async () => {
  const f = await fixture();
  const state = await f.open();
  await seedPending(state, f, 1_100_000);
  const worker = await workerFor(state, "luna");
  f.faux.setResponses([
    (request) => {
      const packet = background(request.messages);
      expect(packet.text).toContain("Main messages 2–54");
      expect(packet.text).not.toContain("needle-pending-original");
      expect(packet.text).not.toContain("artifact:file:0123456789abcdef");
      expect(clampMaxTokensToContext(f.models.getModel("faux", "luna")!, request, 1024)).toBe(1024);
      return fauxAssistantMessage("complete");
    },
  ]);
  await submit(worker);
  f.release();
});

test("the complete prepared tree is preserved and original images remain available on zoom", async () => {
  const f = await fixture({ largeOverview: true });
  const state = await f.open();
  const original = `prepared-original ${"complete historical decision ".repeat(5000)}`;
  await append(state.main, [
    { role: "user", content: [{ type: "text", text: original }, image], timestamp: 1 },
  ]);
  await state.memory.prepare();
  const worker = await workerFor(state, "luna");
  f.faux.setResponses([
    (request) => {
      const packet = background(request.messages);
      expect(packet.text).toContain(original);
      expect(packet.blocks.some((part) => part.type === "image")).toBe(false);
      expect(clampMaxTokensToContext(f.models.getModel("faux", "luna")!, request, 1024)).toBe(1024);
      return fauxAssistantMessage("use locators");
    },
  ]);
  await submit(worker);
  // Image payloads are retrieved from original storage rather than the overview.
  f.faux.setResponses([
    () =>
      fauxAssistantMessage([fauxToolCall("memory_zoom", { id: 0, n: 1 })], {
        stopReason: "toolUse",
      }),
    (request) => {
      const result = request.messages.findLast((message) => message.role === "toolResult")!;
      expect(result).toMatchObject({ toolName: "memory_zoom", isError: false });
      expect(result.content).toContainEqual(image);
      expect(JSON.stringify(result)).toContain(original);
      return fauxAssistantMessage("retrieved");
    },
  ]);
  await submit(worker, "Retrieve original 0 including image");
});

test.each(["explicit", "native"])(
  "%s compaction adopts the prepared tree at the pinned boundary and persists it across restart",
  async (mode) => {
    const f = await fixture({ native: true });
    let state = await f.open();
    const original = await seedPending(state, f, 12_000);
    let worker = await workerFor(state, "tiny");
    f.faux.setResponses([
      (request) => {
        expect(background(request.messages).text).not.toContain(original);
        return fauxAssistantMessage("Progress: source collection complete; journal remains");
      },
    ]);
    await submit(worker);
    const pinned = (await state.harness.snapshot(WorkerMemory, worker.id, context))!;
    expect(pinned.snapshot).toMatchObject({ count: 55, prepared: 2 });
    f.release();
    await state.memory.prepare();
    await append(state.main, [
      { role: "user", content: "FUTURE MAIN DECISION MUST NOT LEAK", timestamp: Date.now() },
    ]);
    expect(await state.memory.prepare()).toContain("FUTURE MAIN DECISION");
    expect(state.memory.status().builtLeaves).toBe(56);
    // Enough real native worker history to trigger automatic compaction. Its
    // task/progress must survive; the inherited main background is not its task.
    for (let index = 0; index < 4; index++)
      await append(worker, [
        {
          role: "user",
          content: `Progress ${index}: completed source collection. ${"trace ".repeat(4000)}`,
          timestamp: Date.now() + index,
        },
      ]);
    const summaries: string[] = [];
    let generations = 0;
    f.faux.setResponses(
      Array.from({ length: 8 }, () => (request) => {
        const transcript = JSON.stringify(request.messages);
        if (transcript.includes("You are a context summarization assistant")) {
          summaries.push(transcript);
          return fauxAssistantMessage(
            "Execute heartbeat; completed source collection. Write journal once.",
          );
        }
        generations++;
        const packet = background(request.messages);
        const view = packet.text.slice(
          packet.text.indexOf("<chat>"),
          packet.text.lastIndexOf("\n</main-memory-background>"),
        );
        expect(snapshotFromView(view.trimEnd())).toMatchObject({ count: 55, prepared: 55 });
        expect(packet.text).not.toContain("not summarized yet");
        expect(packet.text).not.toContain("FUTURE MAIN DECISION");
        expect(transcript).toContain("completed source collection");
        expect(
          request.messages.some(
            (message) =>
              message.role === "user" && message.content === "Finish existing heartbeat journal",
          ),
        ).toBe(true);
        return fauxAssistantMessage("journal written once");
      }),
    );
    if (mode === "explicit")
      await state.harness.waitForTask(await worker.compact(undefined, context), context);
    await submit(worker, "Finish existing heartbeat journal");
    expect(summaries).toHaveLength(1);
    expect(summaries.join("\n")).toContain("completed source collection");
    expect(summaries.join("\n")).not.toContain("FUTURE MAIN DECISION");
    expect(generations).toBe(1);
    const upgraded = (await state.harness.snapshot(WorkerMemory, worker.id, context))!;
    expect(upgraded.snapshot).toMatchObject({ count: 55, prepared: 55 });
    expect(upgraded.view).not.toContain("FUTURE MAIN DECISION");
    const id = worker.id;
    await state.close();
    state = await f.open();
    worker = (await state.harness.conversation(id, context))!;
    expect(await state.harness.snapshot(WorkerMemory, id, context)).toEqual(upgraded);
    f.faux.setResponses([
      (request) => {
        expect(background(request.messages).text).toContain("retained archive decision");
        expect(JSON.stringify(request.messages)).not.toContain("FUTURE MAIN DECISION");
        return fauxAssistantMessage("resumed without repeating source collection");
      },
    ]);
    await submit(worker, "Continue completed journal checkpoint");
    expect(await state.memory.zoom(2, 1)).toContain(original);
  },
);
