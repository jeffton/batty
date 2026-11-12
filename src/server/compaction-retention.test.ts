import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  createRegistry,
  defineExtension,
  defineTool,
  GenerationTask,
  Harness,
  hook,
  section,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

// Match workers: a large pinned prefix exists only in provider requests, whereas
// instructions and tool schemas are canonical pi.system contributions.
const background = `<main-memory-background>${"historical knowledge ".repeat(42_000)}</main-memory-background>`;
const workflow = "WORKFLOW READ: collect sources, preserve completed investigation, then report.";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "batty-compaction-retention-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const models = createModels();
  const faux = fauxProvider({
    models: [{ id: "worker", contextWindow: 272_000, maxTokens: 24_000 }],
  });
  models.setProvider(faux.provider);
  let rounds = 0;
  let summaries = 0;
  const responseUsages: AssistantMessage["usage"][] = [];
  const respond = (request: Parameters<typeof models.streamSimple>[1]) => {
    if (JSON.stringify(request.messages).includes("You are a context summarization assistant")) {
      summaries++;
      return fauxAssistantMessage("Completed historical work retained in checkpoint.");
    }
    expect(
      request.messages.some((message) => message.role === "user" && message.content === background),
    ).toBe(true);
    if (rounds > 0) expect(JSON.stringify(request.messages)).toContain(workflow);
    rounds++;
    const message =
      rounds % 3 === 0
        ? fauxAssistantMessage("Investigation completed.")
        : fauxAssistantMessage([fauxToolCall("read_workflow", {})], { stopReason: "toolUse" });
    return message;
  };
  faux.setResponses(Array.from({ length: 30 }, () => respond));
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "worker-context",
      sections: [section("worker-baseline", () => "instructions ".repeat(7_000))],
      tools: [
        defineTool({
          name: "read_workflow",
          description: "tool schema description ".repeat(2_000),
          parameters: Type.Object({}),
          replay: "safe",
          execute: async () => ({ output: [{ type: "text", text: workflow }] }),
        }),
      ],
      hooks: [
        hook(GenerationTask, {
          afterResponse: (message) => {
            responseUsages.push(structuredClone(message.usage));
          },
          beforeRequest: ({ messages }) => ({
            messages: [{ role: "user", content: background, timestamp: 0 }, ...messages],
          }),
        }),
      ],
    }),
  );
  const open = async () => {
    const storage = await openNodeSqliteStorage(join(directory, "runtime.sqlite"));
    const harness = await Harness.open(
      storage,
      {
        models,
        registry,
        settings: {
          compaction: {
            enabled: true,
            reserveTokens: 24_000,
            keepRecentTokens: 20_000,
            backgroundTokens: 0,
          },
        },
      },
      context,
    );
    const conversation = await harness.root(context, {
      agent: {
        model: { provider: "faux", modelId: "worker" },
      },
    });
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await harness.close(context);
    };
    cleanup.push(close);
    return { harness, conversation, close };
  };
  return { open, summaries: () => summaries, responseUsages };
}

test("large pinned memory and system/tools do not compact away a short worker's task/read progress, including after restart", async () => {
  const fixtureState = await fixture();
  let state = await fixtureState.open();
  const task =
    "Investigate overlapping heartbeats and read the workflow before collecting sources.";
  for (let index = 0; index < 3; index++) {
    const submission = await state.conversation.submit(
      { type: "input", content: index === 0 ? task : "Continue investigation." },
      context,
    );
    expect((await submission.wait(context)).status).toBe("done");
    const view = await state.conversation.context(context);
    expect(view.head).toBeUndefined();
    expect(JSON.stringify(view.messages)).toContain(task);
    expect(JSON.stringify(view.messages)).toContain(workflow);
    const assistants = view.messages.filter(
      (message): message is AssistantMessage => message.role === "assistant",
    );
    expect(assistants.length).toBe((index + 1) * 3);
    expect(assistants.map((assistant) => assistant.usage)).toEqual(fixtureState.responseUsages);
    // The actual provider-measured request exceeds the native threshold; it is
    // not 'fixed' by removing background usage from the persisted response.
    expect(assistants[0]!.usage.totalTokens).toBeGreaterThan(248_000);
    if (index === 0) {
      await state.close();
      state = await fixtureState.open();
    }
  }
  expect(fixtureState.summaries()).toBe(0);
});

test("genuinely long worker progress still compacts with the fixed background preserved", async () => {
  const fixtureState = await fixture();
  const { conversation } = await fixtureState.open();
  await conversation.commit(async (tx) => {
    for (let index = 0; index < 3; index++)
      await tx.appendEntry(conversation.id, {
        kind: "pi.user",
        model: [
          {
            role: "user",
            content: `Old investigation ${index}: ${"evidence ".repeat(12_000)}`,
            timestamp: index + 1,
          },
        ],
      });
  }, context);
  const submission = await conversation.submit(
    { type: "input", content: "Finish the investigation." },
    context,
  );
  expect((await submission.wait(context)).status).toBe("done");
  expect((await conversation.context(context)).head?.kind).toBe("pi.compaction");
  expect(fixtureState.summaries()).toBeGreaterThan(0);
});
