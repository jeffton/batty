import { expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { buildBaseOptions } from "@earendil-works/pi-ai/api/simple-options";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
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

test("model-budget wait releases on the first usable prefix while the writer is still busy", async () => {
  const f = await fixture({ contextWindow: 28_000, maxTokens: 256 });
  const blocked = gate(),
    secondBatch = gate();
  const state = await f.open({
    compress: async (source) => {
      if (source.includes("second batch")) {
        secondBatch.release();
        await blocked.promise;
      }
      return "retained decision";
    },
  });
  cleanup.push(async () => {
    blocked.release();
    await state.memory.close();
    await state.harness.close(context);
  });
  for (let id = 0; id < 128; id++)
    await state.main.commit(
      (tx) =>
        tx.appendEntry(state.main.id, {
          kind: "pi.user",
          model: [
            {
              role: "user",
              content: `${id < 64 ? "first batch" : "second batch"} ${id} ${"x".repeat(1000)}`,
              timestamp: id + 1,
            },
          ],
        }),
      context,
    );
  f.faux.setResponses([
    (request) => {
      const packet = view(request.messages);
      expect(buildBaseOptions(f.models.getModel("faux", "faux-1")!, request).maxTokens).toBe(256);
      expect(snapshotFromView(packet)).toMatchObject({ count: 128, prepared: 64 });
      expect(packet).toContain("retained decision");
      expect(packet).toContain("second batch 64");
      expect(packet).toContain("second batch 127");
      expect(packet).not.toContain("first batch");
      return fauxAssistantMessage([fauxText("answered before the second batch finished")]);
    },
  ]);
  const submission = await state.main.submit({ type: "input", content: "continue" }, context);
  await secondBatch.promise;
  expect((await submission.wait(context)).status).toBe("done");
  expect(state.memory.status().settled).toBe(64);
});

test("tool rounds retain their exact raw messages and only repin history when the model budget requires it", async () => {
  const f = await fixture({ contextWindow: 14_000, maxTokens: 256 });
  const blocked = gate(),
    started = gate();
  const state = await f.open({
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
  await state.memory.sync();
  const settling = state.memory.settle();
  await started.promise;
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
    (request) => {
      original = view(request.messages);
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
      expect(packet).not.toBe(original);
      expect(packet).toContain("compressed historical decision");
      expect(packet).not.toContain("historical original");
      expect(snapshotFromView(packet)).toMatchObject({ count: 1, prepared: 1 });
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
  await settling;
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
