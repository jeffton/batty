import { expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { WorkerDoc } from "./orchestration";
import { WorkerMemory } from "./memory-documents";
import { fixture, cleanup } from "./memory-test-fixture";
import { isMainMemoryView, withoutMainMemory } from "./main-memory-policy";

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
