import { afterEach, expect, test, vi } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { LiveDoc } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamSimple as codexStream } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { withModelStreamTimeout } from "./model-stream-timeout";
import { recoverNetwork } from "./network-recovery";
import { fixture } from "./orchestration-test-fixture";

const models = createModels();
models.setProvider(fauxProvider({ models: [{ id: "timeout-test" }] }).provider);
const model = models.getModel("faux", "timeout-test")!;

afterEach(() => vi.useRealTimers());

function pending(options: SimpleStreamOptions = {}) {
  const source = new AssistantMessageEventStream();
  let providerOptions: SimpleStreamOptions;
  const start = vi.fn((_model, _context, received) => {
    providerOptions = received;
    return source;
  });
  const output = withModelStreamTimeout(start)(
    model,
    { messages: [] },
    { timeoutMs: 1000, ...options },
  );
  return { source, output, start, options: () => providerOptions! };
}

test("silent provider is canceled and partial text survives without executing its unfinished tool call", async () => {
  vi.useFakeTimers();
  const state = pending();
  const partial = fauxAssistantMessage([fauxText("Already streamed")]);
  state.source.push({ type: "text_delta", contentIndex: 0, delta: "Already streamed", partial });
  await vi.advanceTimersByTimeAsync(1000);
  const result = await state.output.result();
  expect(result).toMatchObject({
    stopReason: "error",
    errorMessage: expect.stringContaining("no provider progress"),
  });
  expect(result.content).toEqual(partial.content);
  expect(state.options().signal!.aborted).toBe(true);
  expect(state.start).toHaveBeenCalledTimes(1);
  // A late provider completion cannot overwrite the timeout.
  state.source.push({
    type: "done",
    reason: "stop",
    message: fauxAssistantMessage([fauxText("late")]),
  });
  expect(await state.output.result()).toBe(result);
});

test("reasoning and raw provider progress extend the idle deadline beyond total request duration", async () => {
  vi.useFakeTimers();
  const callback = vi.fn();
  const state = pending({ onProviderStreamEvent: callback });
  let finished = false;
  void state.output.result().then(() => {
    finished = true;
  });
  for (let i = 0; i < 4; i++) {
    await vi.advanceTimersByTimeAsync(750);
    if (i % 2)
      await state.options().onProviderStreamEvent!({ type: "response.in_progress" }, model);
    else
      state.source.push({
        type: "thinking_delta",
        contentIndex: 0,
        delta: "thinking",
        partial: fauxAssistantMessage([]),
      });
  }
  await vi.advanceTimersByTimeAsync(750);
  expect(finished).toBe(false);
  expect(callback).toHaveBeenCalledTimes(2);
  state.source.push({
    type: "done",
    reason: "stop",
    message: fauxAssistantMessage([fauxText("done")]),
  });
  expect((await state.output.result()).stopReason).toBe("stop");
  await vi.advanceTimersByTimeAsync(2000);
  expect(state.options().signal!.aborted).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

test("transport heartbeat does not conceal a stalled model", async () => {
  vi.useFakeTimers();
  const state = pending();
  await vi.advanceTimersByTimeAsync(750);
  await state.options().onProviderStreamEvent!({ type: "ping" }, model);
  await vi.advanceTimersByTimeAsync(250);
  expect((await state.output.result()).stopReason).toBe("error");
});

test.each([false, true])(
  "user cancellation is aborted, including cancellation before dispatch (%s)",
  async (alreadyAborted) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    if (alreadyAborted) controller.abort(new Error("User stopped"));
    const state = pending({ signal: controller.signal });
    if (!alreadyAborted) controller.abort(new Error("User stopped"));
    expect(await state.output.result()).toMatchObject({
      stopReason: "aborted",
      errorMessage: "User stopped",
    });
    expect(state.start).toHaveBeenCalledTimes(alreadyAborted ? 0 : 1);
    if (!alreadyAborted) expect(state.options().signal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  },
);

test("upstream errors remain errors and release the idle timer", async () => {
  vi.useFakeTimers();
  const state = pending();
  const error = fauxAssistantMessage([], { stopReason: "error", errorMessage: "401 Unauthorized" });
  state.source.push({ type: "error", reason: "error", error });
  expect(await state.output.result()).toBe(error);
  expect(vi.getTimerCount()).toBe(0);
});

test("installed Codex SSE adapter cancels a silent response body, not just its response headers", async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          'data: {"type":"response.created","response":{"id":"test-response"}}\n\n',
        ),
      );
    },
    cancel,
  });
  const apiKey = `test.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } }))}.test`;
  const fetch = vi.fn(async () => new Response(body));
  const output = withModelStreamTimeout((_model, request, options) =>
    codexStream(
      { ...model, api: "openai-codex-responses", provider: "openai-codex" },
      normalizeContext(request),
      { ...options, apiKey, transport: "sse", fetch },
    ),
  )(model, { messages: [] }, { timeoutMs: 1000 });
  await vi.advanceTimersByTimeAsync(1000);
  expect(await output.result()).toMatchObject({
    stopReason: "error",
    errorMessage: expect.stringContaining("stalled"),
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(cancel).toHaveBeenCalledTimes(1);
});

test("durable run exposes a timeout and does not execute a completed tool call from an incomplete response", async () => {
  const state = await fixture();
  const tool = vi.fn(async () => ({ output: [{ type: "text" as const, text: "executed" }] }));
  state.registry.install({
    name: "timeout-test",
    tools: [
      {
        name: "should_not_run",
        description: "test",
        parameters: { type: "object", properties: {} },
        execute: tool,
      },
    ],
  });
  state.models.streamSimple = recoverNetwork(
    withModelStreamTimeout((_model, _request, options) => {
      const source = new AssistantMessageEventStream();
      const partial = fauxAssistantMessage([
        { type: "toolCall", id: "not-completed", name: "should_not_run", arguments: {} },
      ]);
      source.push({
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: partial.content[0] as never,
        partial,
      });
      options?.signal?.addEventListener("abort", () => source.end(partial), { once: true });
      return source;
    }),
  );
  // The production default is five minutes; shorten only the test's provider options.
  const stream = state.models.streamSimple.bind(state.models);
  state.models.streamSimple = (model, request, options) =>
    stream(model, request, { ...options, timeoutMs: 30 });
  const { harness, main } = await state.open();
  await (await main.submit({ type: "input", content: "test silence" }, context)).wait(context);
  const live = await harness.snapshot(LiveDoc, main.id, context);
  expect(live?.run).toBeUndefined();
  expect(live?.runFailure).toMatchObject({
    reason: "model_error",
    detail: expect.stringContaining("stalled"),
  });
  expect(tool).not.toHaveBeenCalled();
});

test("a tool can run longer than the model idle timeout without being canceled", async () => {
  const state = await fixture();
  const tool = vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
    return { output: [{ type: "text" as const, text: "tool finished" }] };
  });
  state.registry.install({
    name: "slow-tool-test",
    tools: [
      {
        name: "slow_tool",
        description: "test",
        parameters: { type: "object", properties: {} },
        execute: tool,
      },
    ],
  });
  const stream = withModelStreamTimeout(state.models.streamSimple.bind(state.models));
  state.models.streamSimple = (model, request, options) =>
    stream(model, request, { ...options, timeoutMs: 40 });
  state.faux.setResponses([
    fauxAssistantMessage(
      [{ type: "toolCall", id: "slow-call", name: "slow_tool", arguments: {} }],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("Finished after the tool")]),
  ]);
  const { harness, main } = await state.open();
  await (await main.submit({ type: "input", content: "run the slow tool" }, context)).wait(context);
  expect(tool).toHaveBeenCalledTimes(1);
  expect((await harness.snapshot(LiveDoc, main.id, context))?.runFailure).toBeUndefined();
  expect(JSON.stringify((await main.context(context)).entries)).toContain(
    "Finished after the tool",
  );
});
