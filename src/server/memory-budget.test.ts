import { expect, test, vi } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { buildBaseOptions } from "@earendil-works/pi-ai/api/simple-options";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { SessionMemory } from "./memory-documents";
import { snapshotFromView } from "./memory-snapshot";
import { fixture, cleanup } from "./memory-test-fixture";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function view(messages: readonly { role: string; content: unknown }[]) {
  return messages.find(
    (message) => message.role === "user" && String(message.content).startsWith("<chat>"),
  )!.content as string;
}

test("a session at model capacity waits for archival and continues the same submission without losing history", async () => {
  const f = await fixture({ contextWindow: 10_000, maxTokens: 256 });
  const blocked = gate();
  const started = gate();
  const errors: string[] = [];
  const state = await f.open({
    sessionTailBytes: 1_000,
    onError: (error) => errors.push(String(error)),
    compress: async () => {
      started.release();
      await blocked.promise;
      return "retained decision";
    },
  });
  cleanup.push(async () => {
    blocked.release();
    await state.memory.close();
    await state.harness.close(context);
  });
  const original = `historical original ${"x".repeat(40_000)}`;
  await state.main.commit(
    (tx) =>
      tx.appendEntry(state.main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: original, timestamp: 1 }],
      }),
    context,
  );
  let dispatched = false;
  f.faux.setResponses([
    (request) => {
      dispatched = true;
      const packet = view(request.messages);
      expect(snapshotFromView(packet)).toMatchObject({ count: 1, prepared: 1 });
      expect(packet).toContain("retained decision");
      expect(JSON.stringify(request.messages)).not.toContain(original);
      expect(
        request.messages.filter(
          (message) => message.role === "user" && message.content === "continue",
        ),
      ).toHaveLength(1);
      return fauxAssistantMessage([fauxText("continued after archival")]);
    },
  ]);
  const submission = await state.main.submit({ type: "input", content: "continue" }, context);
  let completed = false;
  const completion = submission.wait(context).then((result) => {
    completed = true;
    return result;
  });
  await started.promise;
  await submission.status(context);
  expect(completed).toBe(false);
  expect(dispatched).toBe(false);
  expect(state.memory.status().settled).toBe(0);
  blocked.release();
  expect((await completion).status).toBe("done");
  expect(dispatched).toBe(true);
  expect(errors).toEqual([]);
  const entries = await state.main.entries({}, 100, undefined, context);
  expect(entries.items.flatMap((entry) => entry.model ?? [])).toContainEqual(
    expect.objectContaining({ role: "user", content: original }),
  );
});

test("byte-pressure archival does not block tools or repin the active run", async () => {
  const f = await fixture({ contextWindow: 50_000, maxTokens: 256 });
  const blocked = gate(),
    started = gate();
  const state = await f.open({
    sessionTailBytes: 1_000,
    compress: async () => {
      started.release();
      await blocked.promise;
      return "compressed historical decision";
    },
  });
  cleanup.push(async () => {
    blocked.release();
    await state.memory.close();
    await state.harness.close(context);
  });
  await state.main.commit(
    (tx) =>
      tx.appendEntry(state.main.id, {
        kind: "pi.user",
        model: [
          { role: "user", content: `historical original ${"x".repeat(18_000)}`, timestamp: 1 },
        ],
      }),
    context,
  );
  const exactOutput = `exact tool output ${"z".repeat(15_000)}`;
  state.registry.install(
    defineExtension({
      name: "large-result",
      tools: [
        defineTool({
          name: "inspect",
          description: "inspect",
          parameters: Type.Object({}),
          replay: "safe",
          execute: async () => {
            blocked.release();
            return { output: [{ type: "text", text: exactOutput }] };
          },
        }),
      ],
    }),
  );
  let original = "";
  f.faux.setResponses([
    async (request) => {
      await started.promise;
      original = view(request.messages);
      expect(request.messages).toContainEqual(
        expect.objectContaining({
          role: "user",
          content: `historical original ${"x".repeat(18_000)}`,
        }),
      );
      expect(state.memory.status().settled).toBe(0);
      expect(snapshotFromView(original)?.prepared).toBe(0);
      const response = fauxAssistantMessage(
        [
          { type: "thinking", thinking: "opaque thought", thinkingSignature: "exact-signature" },
          fauxToolCall("inspect", {}),
        ],
        { stopReason: "toolUse" },
      );
      response.usage = { ...response.usage, input: 10_000, output: 50, totalTokens: 10_050 };
      return response;
    },
    (request) => {
      const packet = view(request.messages);
      expect(buildBaseOptions(f.models.getModel("faux", "faux-1")!, request).maxTokens).toBe(256);
      expect(packet).toBe(original);
      expect(packet).not.toContain("compressed historical decision");
      expect(snapshotFromView(packet)).toMatchObject({ count: 0, prepared: 0 });
      expect(request.messages).toContainEqual(
        expect.objectContaining({
          role: "user",
          content: `historical original ${"x".repeat(18_000)}`,
        }),
      );
      const transcript = JSON.stringify(request.messages);
      expect(transcript).toContain("exact-signature");
      expect(transcript).toContain(exactOutput);
      expect(request.messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
      expect(
        request.messages.filter(
          (message) =>
            message.role === "user" && message.content === "inspect without losing this input",
        ),
      ).toHaveLength(1);
      return fauxAssistantMessage([fauxText("done")]);
    },
  ]);
  expect(
    (
      await (
        await state.main.submit(
          { type: "input", content: "inspect without losing this input" },
          context,
        )
      ).wait(context)
    ).status,
  ).toBe("done");
  await vi.waitFor(async () => {
    const session = await state.harness.snapshot(SessionMemory, state.main.id, context);
    expect(session?.boundary).toBeGreaterThan(0);
  });
  f.faux.setResponses([
    (request) => {
      expect(view(request.messages)).toContain("compressed historical decision");
      expect(JSON.stringify(request.messages)).not.toContain("historical original");
      expect(JSON.stringify(request.messages)).toContain(exactOutput);
      expect(JSON.stringify(request.messages)).toContain("exact-signature");
      return fauxAssistantMessage([fauxText("next done")]);
    },
  ]);
  expect(
    (await (await state.main.submit({ type: "input", content: "next" }, context)).wait(context))
      .status,
  ).toBe("done");
});

test("irreducible active input fails explicitly instead of waiting for unrelated compression", async () => {
  const f = await fixture({ contextWindow: 10_000, maxTokens: 256 });
  const blocked = gate(),
    started = gate();
  const errors: string[] = [];
  const state = await f.open({
    onError: (error) => errors.push(String(error)),
    compress: async () => {
      started.release();
      await blocked.promise;
      return "history";
    },
  });
  cleanup.push(async () => {
    blocked.release();
    await state.memory.close();
    await state.harness.close(context);
  });
  await state.main.commit(
    (tx) =>
      tx.appendEntry(state.main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "history ".repeat(100), timestamp: 1 }],
      }),
    context,
  );
  await state.memory.sync();
  const settling = state.memory.settle();
  await started.promise;
  let dispatched = false;
  f.faux.setResponses([
    () => {
      dispatched = true;
      return fauxAssistantMessage([fauxText("must not run")]);
    },
  ]);
  expect(
    (
      await (
        await state.main.submit({ type: "input", content: "x".repeat(20_000) }, context)
      ).wait(context)
    ).status,
  ).toBe("unanswered");
  expect(dispatched).toBe(false);
  expect(errors.join("\n")).toContain("Active main turn exceeds");
  expect(state.memory.status().settled).toBe(0);
  blocked.release();
  await settling;
});
