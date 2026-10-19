import { expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { fixture, until } from "./orchestration-test-fixture.js";

// A nested start must finish its tool round before the child finishes, even
// without await. Otherwise incoming steering is stuck behind the child's work.
test("nested run returns immediately and parent handles steering while child is blocked", async () => {
  const { faux, orchestration, open, registry } = await fixture();
  const subagent = orchestration.extension.tools!.find((tool) => tool.name === "subagent")!;
  expect(subagent.parameters.properties).not.toHaveProperty("async");
  let parentEntered = false;
  let childEntered = false;
  let releaseParent!: () => void;
  let releaseChild!: () => void;
  const parentGate = new Promise<void>((resolve) => {
    releaseParent = resolve;
  });
  const childGate = new Promise<void>((resolve) => {
    releaseChild = resolve;
  });
  registry.install(
    defineExtension({
      name: "async-start-test",
      tools: [
        defineTool({
          name: "start_gate",
          description: "Hold a worker at its own tool boundary",
          parameters: Type.Object({ child: Type.Boolean() }),
          replay: "safe",
          execute: async ({ child }) => {
            if (child) childEntered = true;
            else parentEntered = true;
            await (child ? childGate : parentGate);
            return { output: [{ type: "text", text: "gate released" }] };
          },
        }),
      ],
    }),
  );
  const { harness, main } = await open();
  const call = (args: { action: string; prompt?: string; sessionId?: string }) =>
    fauxAssistantMessage([fauxToolCall("subagent", args)], { stopReason: "toolUse" });
  let outerId = "";
  faux.setResponses(
    Array.from({ length: 40 }, () => (request) => {
      const last = request.messages.findLast((message) => message.role !== "system")!;
      const text = JSON.stringify(last.content);
      if (last.role === "user" && text.includes("launch start test"))
        return call({ action: "run", prompt: "outer start worker" });
      if (last.role === "user" && text.includes("outer start worker"))
        return call({ action: "run", prompt: "inner start worker" });
      if (last.role === "user" && text.includes("inner start worker"))
        return fauxAssistantMessage([fauxToolCall("start_gate", { child: true })], {
          stopReason: "toolUse",
        });
      if (last.role === "toolResult" && text.includes("Started. Session ID:")) {
        if (
          request.messages.some(
            (message) =>
              message.role === "user" &&
              JSON.stringify(message.content).includes("outer start worker"),
          )
        )
          return fauxAssistantMessage([fauxToolCall("start_gate", { child: false })], {
            stopReason: "toolUse",
          });
        return fauxAssistantMessage([fauxText("main ready")]);
      }
      if (last.role === "user" && text.includes("send start steering"))
        return call({
          action: "steer",
          sessionId: outerId,
          prompt: "inspect before child finishes",
        });
      if (last.role === "user" && text.includes("inspect before child finishes"))
        return fauxAssistantMessage([fauxText("parent steered before child finished")]);
      return fauxAssistantMessage([fauxText("finished")]);
    }),
  );
  try {
    await (
      await main.submit({ type: "input", content: "launch start test" }, context)
    ).wait(context);
    await until(async () => parentEntered && childEntered);
    const running = await orchestration.listRunning();
    const outer = running.find((worker) => worker.prompt === "outer start worker")!;
    const inner = running.find((worker) => worker.prompt === "inner start worker")!;
    outerId = outer.sessionId;
    const parent = (await harness.conversation(outer.conversationId, context))!;
    const started = (await parent.context(context)).messages.find(
      (message) => message.role === "toolResult" && message.toolName === "subagent",
    )!;
    expect(started).toMatchObject({
      content: [{ type: "text", text: `Started. Session ID: ${inner.sessionId}` }],
      details: { subagent: { sessionId: inner.sessionId, respondIn: "session" } },
    });
    await (
      await main.submit({ type: "input", content: "send start steering" }, context)
    ).wait(context);
    releaseParent();
    await until(async () =>
      JSON.stringify((await parent.context(context)).messages).includes(
        "parent steered before child finished",
      ),
    );
    expect(
      (await orchestration.listRunning()).some((worker) => worker.sessionId === inner.sessionId),
    ).toBe(true);
  } finally {
    releaseParent();
    releaseChild();
  }
  await until(async () => (await orchestration.listRunning()).length === 0);
}, 15000);
