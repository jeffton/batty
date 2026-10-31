import { expect, test, vi } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { Message } from "@earendil-works/pi-ai";
import { WorkerDoc } from "./orchestration";
import { SessionMemory } from "./memory-documents";
import {
  rolloverBoundary,
  sessionBytes,
  sessionMessages,
  SESSION_IMAGE_BYTES,
} from "./session-tail";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { fixture, cleanup } from "./memory-test-fixture";

test("context budget ignores transport size while retaining image and reasoning originals", () => {
  const photo: Message = {
    role: "user",
    content: [{ type: "image", data: "A".repeat(4_000_000), mimeType: "image/jpeg" }],
    timestamp: 1,
  };
  const smallerPhoto: Message = {
    ...photo,
    content: [{ type: "image", data: "AAAA", mimeType: "image/jpeg" }],
  };
  expect(sessionBytes([photo])).toBe(32 + SESSION_IMAGE_BYTES);
  expect(sessionBytes([photo])).toBe(sessionBytes([smallerPhoto]));
  expect(
    sessionBytes([
      {
        ...photo,
        content: Array.from({ length: 2 }, () => ({
          type: "image" as const,
          data: "AAAA",
          mimeType: "image/jpeg",
        })),
      },
    ]),
  ).toBe(32 + 2 * SESSION_IMAGE_BYTES);
  const call = fauxAssistantMessage([
    { type: "toolCall", id: "call", name: "check", arguments: { value: "å" } },
  ]);
  expect(sessionBytes([call])).toBe(32 + 5 + Buffer.byteLength('{"value":"å"}'));
  expect(
    sessionBytes([
      {
        role: "toolResult",
        toolCallId: "call",
        toolName: "check",
        content: [{ type: "text", text: "result" }],
        isError: false,
        timestamp: 1,
      },
    ]),
  ).toBe(32 + 6);
  const thinking = fauxAssistantMessage([
    { type: "thinking", thinking: "reasoning", thinkingSignature: "S".repeat(500_000) },
    fauxText("answer"),
  ]);
  expect(sessionBytes([thinking])).toBe(32 + 9 + 6);
  expect(sessionBytes([{ role: "user", content: "å", timestamp: 1 }])).toBe(34);
  const entries = [
    { id: 1, model: [photo, thinking] },
    { id: 2, model: [{ role: "user", content: "next", timestamp: 2 }] },
  ].map((entry) => ({ conversationId: 1, kind: "test", ...entry })) as unknown as EntryRecord[];
  expect(rolloverBoundary(entries, 2, 200_000)).toBeUndefined();
  expect(sessionMessages(entries)[0]).toBe(photo);
  expect(sessionMessages(entries)[1]).toBe(thinking);
  expect(rolloverBoundary(entries, 2, 5_000)).toBe(2);
});

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

test("preparation below the threshold keeps the prompt stable, stays nonblocking and is reused after restart", async () => {
  const f = await fixture();
  const blocked = gate();
  const started = gate();
  const sources: string[] = [];
  let hold = true;
  const options = {
    sessionTailBytes: 1_200,
    compress: async (source: string) => {
      sources.push(source);
      if (hold) {
        started.release();
        await blocked.promise;
      }
      return "prepared decision";
    },
  };
  const state = await f.open(options);
  cleanup.push(async () => {
    blocked.release();
    await state.memory.close();
    await state.harness.close(context);
  });
  const requests: Message[][] = [];
  const response = (request: { messages: Message[] }) => {
    requests.push(request.messages);
    return fauxAssistantMessage([fauxText("reply")]);
  };
  const submit = async (main: typeof state.main, content: string) =>
    expect(
      (await (await main.submit({ type: "input", content }, context)).wait(context)).status,
    ).toBe("done");
  f.faux.setResponses([response, response, response, response]);
  const original = "first decision ".repeat(45);
  await submit(state.main, original);
  await started.promise;
  // No rollover is due. Even stalled preparatory inference must not delay a turn.
  await submit(state.main, "second input");
  expect(view(requests[1]!)).toBe(view(requests[0]!));
  expect(JSON.stringify(requests[1])).toContain(original);
  expect((await state.harness.snapshot(SessionMemory, state.main.id, context))!.boundary).toBe(0);
  hold = false;
  blocked.release();
  await vi.waitFor(() => {
    const status = state.memory.status();
    expect(status.builtLeaves).toBeGreaterThanOrEqual(4);
    expect(status.builtLeaves).toBe(status.totalLeaves);
  });
  expect((await state.harness.snapshot(SessionMemory, state.main.id, context))!.boundary).toBe(0);
  await state.memory.close();
  await state.harness.close(context);
  const reopened = await f.open(options);
  cleanup.push(async () => {
    await reopened.memory.close();
    await reopened.harness.close(context);
  });
  // The next completed run crosses the byte threshold; cached summaries survive
  // restart and are reused when the session prefix is finally switched.
  await submit(reopened.main, "third decision ".repeat(45));
  expect(view(requests[2]!)).toBe(view(requests[0]!));
  expect(JSON.stringify(requests[2])).toContain(original);
  await vi.waitFor(async () =>
    expect(
      (await reopened.harness.snapshot(SessionMemory, reopened.main.id, context))!.boundary,
    ).toBeGreaterThan(0),
  );
  await submit(reopened.main, "fourth input");
  expect(JSON.stringify(requests[3])).not.toContain(original);
  expect(JSON.stringify(requests[3])).toContain("prepared decision");
  expect(sources.filter((source) => source.includes(original.trim()))).toHaveLength(1);
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
  "assistant-workspace workers pin prepared main decisions and reports as background, initialized=%s",
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
    await state.memory.prepare();
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
        expect(text).toContain("main-memory-background");
        expect(request.messages.at(-1)).toMatchObject({
          role: "user",
          content: "independent task",
        });
        expect(
          request.messages.some(
            (message) => message.role === "user" && message.content === "recent main input",
          ),
        ).toBe(false);
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
