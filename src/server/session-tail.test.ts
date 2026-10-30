import { expect, test, vi } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { Message } from "@earendil-works/pi-ai";
import { WorkerDoc } from "./orchestration";
import { SessionMemory } from "./memory-documents";
import { rolloverBoundary, sessionMessages } from "./session-tail";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { fixture, cleanup } from "./memory-test-fixture";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function view(messages: readonly Message[]) {
  return messages.find(
    (message) =>
      message.role === "user" &&
      typeof message.content === "string" &&
      message.content.startsWith("<chat>"),
  )!.content;
}

test("async byte rollover retains every original until a complete prefix is published, then survives restart", async () => {
  const f = await fixture();
  const blocked = gate();
  let started = false;
  const state = await f.open({
    sessionTailBytes: 1_200,
    compress: async () => {
      started = true;
      await blocked.promise;
      return "archived original and report";
    },
  });
  cleanup.push(async () => {
    blocked.release();
    await state.harness.close(context);
    await state.memory.close();
  });
  const requests: Message[][] = [];
  const response = (request: { messages: Message[] }) => {
    requests.push(request.messages);
    return fauxAssistantMessage([fauxText("original reply")]);
  };
  f.faux.setResponses([response, response, response]);
  const first = await state.main.submit(
    { type: "input", content: "original ".repeat(200) },
    context,
  );
  expect((await first.wait(context)).status).toBe("done");
  await state.main.commit(
    (tx) =>
      tx.appendEntry(state.main.id, {
        kind: "batty.import-note",
        model: [
          { role: "user", content: "subagent report: valuable result", timestamp: Date.now() },
        ],
      }),
    context,
  );
  expect(
    (await (await state.main.submit({ type: "input", content: "second" }, context)).wait(context))
      .status,
  ).toBe("done");
  await vi.waitFor(() => expect(started).toBe(true));
  expect(JSON.stringify(requests[1])).toContain("subagent report: valuable result");
  expect(JSON.stringify(requests[1])).toContain("original ".repeat(200));
  expect(view(requests[1]!)).toBe(view(requests[0]!));
  expect((await state.harness.snapshot(SessionMemory, state.main.id, context))?.boundary).toBe(0);
  blocked.release();
  await vi.waitFor(async () =>
    expect(
      (await state.harness.snapshot(SessionMemory, state.main.id, context))!.boundary,
    ).toBeGreaterThan(0),
  );
  expect(
    (await (await state.main.submit({ type: "input", content: "third" }, context)).wait(context))
      .status,
  ).toBe("done");
  expect(JSON.stringify(requests[2])).not.toContain("original ".repeat(200));
  expect(JSON.stringify(requests[2])).toContain("archived original and report");
  expect(JSON.stringify(requests[2])).toContain("second");
  const prefix = view(requests[2]!);
  await state.harness.close(context);
  await state.memory.close();
  const reopened = await f.open({ sessionTailBytes: 1_200 });
  cleanup.push(async () => {
    await reopened.harness.close(context);
    await reopened.memory.close();
  });
  f.faux.setResponses([
    (request) => {
      expect(view(request.messages)).toBe(prefix);
      expect(JSON.stringify(request.messages)).toContain("third");
      expect(JSON.stringify(request.messages)).toContain("second");
      return fauxAssistantMessage([fauxText("after restart")]);
    },
  ]);
  expect(
    (
      await (
        await reopened.main.submit({ type: "input", content: "fourth" }, context)
      ).wait(context)
    ).status,
  ).toBe("done");
});

test("archival failure preserves the complete session and retries without waiting for inference", async () => {
  const f = await fixture();
  let failing = true;
  const errors: unknown[] = [];
  const state = await f.open({
    sessionTailBytes: 1_000,
    retryMs: 1,
    onError: (error) => errors.push(error),
    compress: async () => {
      if (failing) throw new Error("archival unavailable");
      return "prepared archive";
    },
  });
  cleanup.push(async () => {
    await state.harness.close(context);
    await state.memory.close();
  });
  f.faux.setResponses(
    Array.from({ length: 4 }, () => () => fauxAssistantMessage([fauxText("reply")])),
  );
  const submit = async (content: string) =>
    expect(
      (await (await state.main.submit({ type: "input", content }, context)).wait(context)).status,
    ).toBe("done");
  await submit("must retain ".repeat(200));
  await submit("second");
  await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0));
  expect((await state.harness.snapshot(SessionMemory, state.main.id, context))?.boundary).toBe(0);
  failing = false;
  await submit("third");
  await vi.waitFor(async () =>
    expect(
      (await state.harness.snapshot(SessionMemory, state.main.id, context))!.boundary,
    ).toBeGreaterThan(0),
  );
  const original = (await state.main.entries({}, 100, undefined, context)).items;
  expect(JSON.stringify(original)).toContain("must retain ".repeat(200));
});

test("capacity recovery archives another batch when a formerly current run has grown the tail", async () => {
  const f = await fixture({ contextWindow: 20_000, maxTokens: 256 });
  const blocked = gate();
  const started = gate();
  const state = await f.open({
    sessionTailBytes: 1_000,
    compress: async () => {
      started.release();
      await blocked.promise;
      return "archived batch";
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
        model: [{ role: "user", content: "old ".repeat(2_000), timestamp: 1 }],
      }),
    context,
  );
  const previous = "previous " + "x".repeat(38_000);
  const current = "current " + "y".repeat(38_000);
  f.faux.setResponses([
    () => fauxAssistantMessage([fauxText("previous reply")]),
    (request) => {
      expect(JSON.stringify(request.messages)).not.toContain(previous);
      expect(JSON.stringify(request.messages)).toContain(current);
      return fauxAssistantMessage([fauxText("capacity recovered")]);
    },
  ]);
  expect(
    (await (await state.main.submit({ type: "input", content: previous }, context)).wait(context))
      .status,
  ).toBe("done");
  await started.promise;
  const pending = await state.main.submit({ type: "input", content: current }, context);
  blocked.release();
  expect((await pending.wait(context)).status).toBe("done");
});

test("native history applies edits and pairs real results before interleaved reports", () => {
  const call = fauxAssistantMessage(
    [{ type: "toolCall", id: "call", name: "check", arguments: {} }],
    { stopReason: "toolUse" },
  );
  const entries = [
    { id: 1, model: [call] },
    { id: 2, model: [{ role: "user", content: "subagent result", timestamp: 2 }] },
    {
      id: 3,
      model: [
        {
          role: "toolResult",
          toolCallId: "call",
          toolName: "check",
          content: [{ type: "text", text: "real result" }],
          isError: false,
          timestamp: 3,
        },
      ],
    },
    { id: 4, model: [{ role: "user", content: "original", timestamp: 4 }] },
    {
      id: 5,
      edits: [
        {
          target: 4,
          action: "replace",
          messages: [{ role: "user", content: "replacement", timestamp: 4 }],
        },
      ],
    },
    { id: 6, model: [fauxAssistantMessage([fauxText("failed")], { stopReason: "error" })] },
  ].map((entry) => ({ conversationId: 1, kind: "test", ...entry })) as unknown as EntryRecord[];
  const messages = sessionMessages(entries);
  expect(messages.map((message) => message.role)).toEqual([
    "assistant",
    "toolResult",
    "user",
    "user",
  ]);
  expect(JSON.stringify(messages)).toContain("real result");
  expect(JSON.stringify(messages)).toContain("replacement");
  expect(JSON.stringify(messages)).not.toContain("original");
  expect(JSON.stringify(messages)).not.toContain("failed");
  const largeResult = structuredClone(entries);
  largeResult[2] = {
    ...largeResult[2]!,
    model: [
      {
        role: "toolResult",
        toolCallId: "call",
        toolName: "check",
        content: [{ type: "text", text: "large output ".repeat(200) }],
        isError: false,
        timestamp: 3,
      },
    ],
  };
  largeResult.push({
    id: 7,
    conversationId: 1,
    kind: "pi.user",
    model: [{ role: "user", content: "next", timestamp: 7 }],
  } as unknown as EntryRecord);
  expect(rolloverBoundary(largeResult, 7, 1_000)).toBe(7);
  expect(sessionMessages(entries.slice(0, 2))[1]).toMatchObject({
    role: "toolResult",
    isError: true,
    toolCallId: "call",
  });
});

test.each([true, false])(
  "assistant-workspace workers pin main originals and reports, initialized=%s",
  async (initialized) => {
    const f = await fixture();
    const state = await f.open({ getAssistantWorkspaceId: async () => "assistant" });
    cleanup.push(async () => {
      await state.harness.close(context);
      await state.memory.close();
    });
    f.faux.setResponses([() => fauxAssistantMessage([fauxText("recent main reply")])]);
    if (initialized)
      await (
        await state.main.submit({ type: "input", content: "recent main input" }, context)
      ).wait(context);
    else
      await state.main.commit(
        (tx) =>
          tx.appendEntry(state.main.id, {
            kind: "pi.user",
            model: [{ role: "user", content: "recent main input", timestamp: 1 }],
          }),
        context,
      );
    await state.main.commit(
      (tx) =>
        tx.appendEntry(state.main.id, {
          kind: "batty.import-note",
          model: [{ role: "user", content: "recent subagent finding", timestamp: Date.now() }],
        }),
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
    f.faux.setResponses([
      (request) => {
        const text = JSON.stringify(request.messages);
        expect(text).toContain("recent main input");
        if (initialized) expect(text).toContain("recent main reply");
        expect(text).toContain("recent subagent finding");
        return fauxAssistantMessage([fauxText("worker done")]);
      },
    ]);
    expect(
      (
        await (
          await worker.submit({ type: "input", content: "independent task" }, context)
        ).wait(context)
      ).status,
    ).toBe("done");
  },
);
