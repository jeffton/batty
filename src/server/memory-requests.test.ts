import { expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Type } from "@earendil-works/pi-ai";
import {
  createRegistry,
  Harness,
  ProviderDoc,
  MemoryStorage,
  defineExtension,
  defineTool,
} from "@earendil-works/pi-durable";
import { createMemory } from "./memory";
import { fixture, cleanup } from "./memory-test-fixture";

test("fatal memory preparation aborts without dispatching raw canonical history", async () => {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  let calls = 0;
  faux.setResponses([
    (request) => {
      calls++;
      return fauxAssistantMessage([fauxText(String(request.messages.length))]);
    },
  ]);
  const memory = createMemory(
    { memoryModel: "missing/model", nodeBytes: 1, viewBytes: 1, onError: () => undefined },
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
  const main = await harness.root(context, {
    agent: { model: { provider: "faux", modelId: "faux-1" } },
  });
  cleanup.push(async () => {
    await harness.close(context);
    await memory.close();
  });
  await main.commit(
    (tx) =>
      tx.appendEntry(main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "private original", timestamp: 1 }],
      }),
    context,
  );
  await memory.bind(harness, main, storage);
  const settled = await (
    await main.submit({ type: "input", content: "new input" }, context)
  ).wait(context);
  expect(settled.status).toBe("unanswered");
  expect(calls).toBe(0);
  expect(memory.status().error).toContain("Memory model unavailable");
});

test("each run starts from a persisted view and the full new input, never old raw turns", async () => {
  const fixtureState = await fixture();
  const state = await fixtureState.open();
  cleanup.push(() => state.harness.close(context));
  const requests: unknown[] = [];
  fixtureState.faux.setResponses([
    (request) => {
      requests.push(request.messages);
      return fauxAssistantMessage([fauxText("old exact reply")]);
    },
    (request) => {
      requests.push(request.messages);
      return fauxAssistantMessage([fauxText("new reply")]);
    },
  ]);
  await (
    await state.main.submit({ type: "input", content: "first", requestId: "first" }, context)
  ).wait(context);
  await (
    await state.main.submit({ type: "input", content: "second", requestId: "second" }, context)
  ).wait(context);
  const second = requests[1] as { role: string; content: unknown }[];
  expect(second.some((message) => message.role === "assistant")).toBe(false);
  expect(JSON.stringify(second)).toContain("old exact reply");
  expect(JSON.stringify(second)).toContain("batty-optchat:");
  expect(second[0]!.role).toBe("system");
  expect(second[0]).toEqual((requests[0] as { role: string; content: unknown }[])[0]);
  expect(second.filter((message) => message.role === "system")).toHaveLength(1);
  expect(JSON.stringify(second)).toContain("second");
  const provider = (await state.harness.snapshot(ProviderDoc, state.main.id, context))!;
  expect(() =>
    state.memory.validateRequest(
      { messages: [{ role: "user", content: "raw canonical", timestamp: 0 }] },
      { sessionId: provider.sessionId },
    ),
  ).toThrow("no persisted OptChat");
});

test("a run's tool loop preserves reasoning signatures and its frozen view verbatim", async () => {
  const fixtureState = await fixture();
  const state = await fixtureState.open();
  cleanup.push(() => state.harness.close(context));
  state.registry.install(
    defineExtension({
      name: "test-tools",
      tools: [
        defineTool({
          name: "check",
          description: "check",
          parameters: Type.Object({}),
          replay: "safe",
          execute: async () => ({ output: [{ type: "text", text: "exact tool output" }] }),
        }),
      ],
    }),
  );
  await state.main.commit(
    (tx) =>
      tx.appendEntry(state.main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "archived input", timestamp: 1 }],
      }),
    context,
  );
  const requests: { role: string; content: unknown }[][] = [];
  fixtureState.faux.setResponses([
    (request) => {
      requests.push(request.messages);
      return fauxAssistantMessage(
        [
          { type: "thinking", thinking: "opaque thought", thinkingSignature: "encrypted-exact" },
          fauxToolCall("check", {}),
        ],
        { stopReason: "toolUse" },
      );
    },
    async (request) => {
      requests.push(request.messages);
      return fauxAssistantMessage([fauxText("done")]);
    },
  ]);
  const originalStream = fixtureState.models.streamSimple.bind(fixtureState.models);
  fixtureState.models.streamSimple = (model, request, options) => {
    state.memory.validateRequest(request, options);
    return originalStream(model, request, options);
  };
  const settled = await (
    await state.main.submit({ type: "input", content: "use check" }, context)
  ).wait(context);
  expect(settled.status).toBe("done");
  expect(requests).toHaveLength(2);
  expect(JSON.stringify(requests[1])).toContain("encrypted-exact");
  expect(JSON.stringify(requests[1])).toContain("exact tool output");
  const packet = (request: { role: string; content: unknown }[]) =>
    request.find(
      (message) => message.role === "user" && String(message.content).startsWith("<chat>"),
    )!.content;
  expect(packet(requests[0]!)).toEqual(packet(requests[1]!));
  expect(requests[0]![0]!.role).toBe("system");
  expect(requests[0]![0]).toEqual(requests[1]![0]);
  for (const request of requests)
    expect(request.filter((message) => message.role === "system")).toHaveLength(1);
  expect(JSON.stringify(requests[0]![0])).toContain('"name":"check"');
  expect(
    (await state.main.context(context)).messages.some(
      (message) => message.role === "user" && message.content === "archived input",
    ),
  ).toBe(false);
  expect(
    (await state.main.entries({}, 100, undefined, context)).items.some((entry) =>
      entry.model?.some(
        (message) => message.role === "user" && message.content === "archived input",
      ),
    ),
  ).toBe(true);
});
