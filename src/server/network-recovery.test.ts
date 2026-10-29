import { expect, test, vi } from "vite-plus/test";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { LiveDoc } from "@earendil-works/pi-durable";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { recoverNetwork, networkAvailable, isTransportMessage } from "./network-recovery";
import { fixture, until } from "./orchestration-test-fixture";

const offlineError = () =>
  fauxAssistantMessage([], { stopReason: "error", errorMessage: "fetch failed" });

test("offline request survives SQLite reopen without committing model errors or duplicating the input", async () => {
  const state = await fixture();
  let waiting = false;
  let online = false;
  const report = vi.fn();
  state.models.streamSimple = recoverNetwork(state.models.streamSimple.bind(state.models), {
    online: async () => online,
    wait: async (signal) => {
      waiting = true;
      await delay(60_000, undefined, { signal });
    },
    report,
  });
  state.faux.setResponses([
    fauxAssistantMessage([fauxText("interrupted response")], {
      stopReason: "error",
      errorMessage: "fetch failed",
    }),
  ]);
  let { harness, main } = await state.open();
  await main.submit({ type: "input", content: "do not lose this request" }, context);
  await until(async () => waiting);
  await until(
    async () =>
      (await harness.snapshot(LiveDoc, main.id, context))?.generation?.message !== undefined,
  );
  const partial = (await harness.snapshot(LiveDoc, main.id, context))!.generation!.message!;
  expect(partial.errorMessage).toBeUndefined();
  expect(partial.stopReason).not.toBe("error");
  expect(JSON.stringify((await main.context(context)).entries)).not.toContain("fetch failed");
  await harness.close(context);
  online = true;
  state.faux.setResponses([fauxAssistantMessage([fauxText("resumed answer")])]);
  ({ harness, main } = await state.open());
  await main.waitForIdle(context);
  const entries = (await main.context(context)).entries;
  expect(entries.flatMap((e) => e.model ?? []).filter((m) => m.role === "user")).toHaveLength(1);
  expect(JSON.stringify(entries)).toContain("resumed answer");
  expect(JSON.stringify(entries)).not.toContain("fetch failed");
  expect(report).toHaveBeenCalledWith(expect.stringContaining("remains pending"));
});

test("same request retries after connectivity returns, with no failed attempt in history", async () => {
  const state = await fixture();
  const requests: unknown[] = [];
  const original = state.models.streamSimple.bind(state.models);
  let probes = 0;
  state.models.streamSimple = recoverNetwork(
    (...args) => {
      requests.push(args[1]);
      return original(...args);
    },
    {
      online: async () => ++probes >= 3,
      wait: async () => {},
      report: () => {},
    },
  );
  state.faux.setResponses([
    fauxAssistantMessage([fauxText("discard interrupted partial")], {
      stopReason: "error",
      errorMessage: "fetch failed",
    }),
    fauxAssistantMessage([fauxText("success")]),
  ]);
  const { main } = await state.open();
  await (await main.submit({ type: "input", content: "retry me" }, context)).wait(context);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toBe(requests[0]);
  const entries = JSON.stringify((await main.context(context)).entries);
  expect(entries).toContain("success");
  expect(entries).not.toContain("fetch failed");
  expect(entries).not.toContain("discard interrupted partial");
});

test("stopping an offline request cancels its wait without a model error", async () => {
  const state = await fixture();
  let waiting = false;
  state.models.streamSimple = recoverNetwork(state.models.streamSimple.bind(state.models), {
    online: async () => false,
    wait: async (signal) => {
      waiting = true;
      await delay(60_000, undefined, { signal });
    },
    report: () => {},
  });
  state.faux.setResponses([offlineError()]);
  const { main } = await state.open();
  await main.submit({ type: "input", content: "cancel me" }, context);
  await until(async () => waiting);
  await main.abort(context);
  await main.waitForIdle(context);
  expect(JSON.stringify((await main.context(context)).entries)).not.toContain("fetch failed");
});

for (const timing of ["same microtask", "later"] as const) {
  test(`nonterminal snapshot cannot acquire provider error metadata: ${timing}`, async () => {
    const state = await fixture();
    await state.open();
    const source = new AssistantMessageEventStream();
    const message = fauxAssistantMessage([fauxText("partial")], { stopReason: "pending" });
    source.push({ type: "text_delta", contentIndex: 0, delta: "partial", partial: message });
    const finish = () => {
      message.stopReason = "error";
      message.errorMessage = "fetch failed";
      source.push({ type: "error", reason: "error", error: message });
    };
    if (timing === "same microtask") finish();
    else void delay(20).then(finish);
    const output = recoverNetwork(() => source, { online: async () => true })(
      state.models.getModel("faux", "faux-1")!,
      { messages: [] },
    );
    for await (const event of output) {
      if (event.type === "done" || event.type === "error") continue;
      await output.result();
      expect(event.partial.stopReason).toBe("pending");
      expect(event.partial.errorMessage).toBeUndefined();
    }
    expect((await output.result()).errorMessage).toBe("fetch failed");
  });
}

for (const text of [
  "fetch failed",
  "terminated",
  "WebSocket closed 1006",
  "WebSocket stream closed before response.completed",
  "OAuth refresh failed for openai-codex: fetch failed",
]) {
  test(`recognizes installed provider's transport error: ${text}`, () => {
    expect(
      isTransportMessage(fauxAssistantMessage([], { stopReason: "error", errorMessage: text })),
    ).toBe(true);
  });
}

for (const error of [
  "401 Unauthorized",
  "429 rate limit",
  "500 server error",
  "certificate has expired",
  "invalid model",
  "OAuth refresh failed for openai-codex: invalid_grant",
  "WebSocket closed 1008 Unauthorized",
]) {
  test(`real provider error stays visible: ${error}`, async () => {
    const state = await fixture();
    await state.open();
    const online = vi.fn(async () => false);
    state.models.streamSimple = recoverNetwork(state.models.streamSimple.bind(state.models), {
      online,
    });
    state.faux.setResponses([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: error }),
    ]);
    const result = await state.models
      .streamSimple(state.models.getModel("faux", "faux-1")!, { messages: [] })
      .result();
    expect(result).toMatchObject({ stopReason: "error", errorMessage: error });
    expect(online).not.toHaveBeenCalled();
  });
}

test("transport failure while internet is available remains a genuine provider error", async () => {
  const state = await fixture();
  await state.open();
  state.models.streamSimple = recoverNetwork(state.models.streamSimple.bind(state.models), {
    online: async () => true,
  });
  state.faux.setResponses([offlineError()]);
  const result = await state.models
    .streamSimple(state.models.getModel("faux", "faux-1")!, { messages: [] })
    .result();
  expect(result).toMatchObject({ stopReason: "error", errorMessage: "fetch failed" });
});

test("network probe is abortable", async () => {
  await expect(networkAvailable(AbortSignal.abort())).rejects.toThrow();
});
