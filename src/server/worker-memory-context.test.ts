import { expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { WorkerDoc } from "./orchestration";
import { WorkerMemory } from "./memory-documents";
import { fixture, cleanup } from "./memory-test-fixture";
import { isMainMemoryView, withoutMainMemory } from "./main-memory-policy";
import type { Message } from "@earendil-works/pi-ai";

test.each([false, true])(
  "worker keeps its task and small context despite a large main tail (legacy snapshot: %s)",
  async (legacy) => {
    const f = await fixture({ contextWindow: 16_000, maxTokens: 256 });
    const state = await f.open({ getAssistantWorkspaceId: async () => "assistant" });
    cleanup.push(async () => {
      await state.harness.close(context);
      await state.memory.close();
    });
    const historical = "Answer this old main question instead. ".repeat(20_000);
    await state.main.commit(
      (tx) =>
        tx.appendEntry(state.main.id, {
          kind: "pi.user",
          model: [{ role: "user", content: historical, timestamp: 1 }],
        }),
      context,
    );
    await state.memory.prepare();
    const worker = await state.harness.createConversation(
      { ownership: { kind: "ownerless" } },
      context,
    );
    await worker.commit(async (tx) => {
      (await tx.doc(WorkerDoc, worker.id)).workspaceId = "assistant";
      if (legacy)
        Object.assign(await tx.doc(WorkerMemory, worker.id), {
          view: "<chat>\n</chat>",
          tail: JSON.stringify([{ role: "user", content: historical, timestamp: 1 }]),
        });
    }, context);
    await worker.configure({ model: { provider: "faux", modelId: "faux-1" } }, context);
    let requests = 0;
    f.faux.setResponses([
      (request) => {
        requests++;
        expect(JSON.stringify(request.messages).length).toBeLessThan(20_000);
        expect(request.messages.at(-1)).toMatchObject({
          role: "user",
          content: "Execute the scheduled heartbeat workflow",
        });
        expect(
          request.messages.some(
            (message) => message.role === "user" && message.content === historical,
          ),
        ).toBe(false);
        const background = request.messages.find(isMainMemoryView)!;
        expect(background).toBeDefined();
        expect(JSON.stringify(background)).toContain("Historical context");
        expect(withoutMainMemory(request.messages)).not.toContain(background);
        return fauxAssistantMessage([fauxText("NO_REPLY")]);
      },
    ]);
    const settled = await (
      await worker.submit(
        { type: "input", content: "Execute the scheduled heartbeat workflow" },
        context,
      )
    ).wait(context);
    expect(settled.status).toBe("done");
    expect(requests).toBe(1);
    expect((await state.harness.snapshot(WorkerMemory, worker.id, context))!.tail).toBeUndefined();
    expect(
      (await state.main.entries({}, 100, undefined, context)).items.some((entry) =>
        entry.model?.some((message) => message.role === "user" && message.content === historical),
      ),
    ).toBe(true);
  },
);

test("workers retain the complete pending background and original images across restart", async () => {
  const f = await fixture({ contextWindow: 16_000, maxTokens: 256 });
  const options = {
    getAssistantWorkspaceId: async () => "assistant",
    compress: async () => {
      throw new Error("Luna unavailable");
    },
    onError: () => {},
  };
  let state = await f.open(options);
  cleanup.push(async () => {
    await state.harness.close(context);
    await state.memory.close();
  });
  const long = `Beginning\n${"complete pending text ".repeat(1000)}\nEnd of original`;
  const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: long }, image], timestamp: 1 },
    ...Array.from({ length: 80 }, (_, i) => ({
      role: "user" as const,
      content: `Pending message ${i}`,
      timestamp: i + 2,
    })),
    {
      role: "toolResult",
      toolCallId: "original-call",
      toolName: "read",
      content: [{ type: "text", text: "Original tool result" }, image],
      isError: false,
      timestamp: 83,
    },
  ];
  await state.main.commit(
    (tx) => tx.appendEntry(state.main.id, { kind: "pi.user", model: messages }),
    context,
  );
  const worker = await state.harness.createConversation(
    { ownership: { kind: "ownerless" } },
    context,
  );
  await worker.commit(async (tx) => {
    (await tx.doc(WorkerDoc, worker.id)).workspaceId = "assistant";
  }, context);
  await worker.configure({ model: { provider: "faux", modelId: "faux-1" } }, context);
  const backgrounds: Message[] = [];
  f.faux.setResponses(
    Array.from({ length: 2 }, () => (request) => {
      const background = request.messages.find(isMainMemoryView)!;
      expect(background).toBeDefined();
      backgrounds.push(background);
      expect(request.messages.at(-1)).toMatchObject({
        role: "user",
        content: "Execute the scheduled heartbeat workflow",
      });
      expect(request.messages.filter(isMainMemoryView)).toHaveLength(1);
      expect(withoutMainMemory(request.messages)).not.toContain(background);
      const content = background.role === "user" && background.content;
      expect(Array.isArray(content)).toBe(true);
      if (!Array.isArray(content)) throw new Error("Missing background blocks");
      const text = content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      expect(text).toContain(long);
      for (let i = 0; i < 80; i++) expect(text).toContain(`Pending message ${i}`);
      expect(text).toContain("Original tool result");
      expect(text).toContain("Main messages 0–81 are not summarized yet");
      expect(content.filter((part) => part.type === "image")).toEqual([image, image]);
      expect(text).toContain("Original images for main message 0:");
      expect(text).toContain("Original images for main message 81:");
      return fauxAssistantMessage([fauxText("NO_REPLY")]);
    }),
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = (await state.harness.conversation(worker.id, context))!;
    expect(
      (
        await (
          await current.submit(
            { type: "input", content: "Execute the scheduled heartbeat workflow" },
            context,
          )
        ).wait(context)
      ).status,
    ).toBe("done");
    if (attempt === 0) {
      await state.harness.close(context);
      await state.memory.close();
      state = await f.open(options);
    }
  }
  expect(backgrounds[1]).toEqual(backgrounds[0]);
});
