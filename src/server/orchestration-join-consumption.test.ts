import { expect, test, vi } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { fixture, until } from "./orchestration-test-fixture";
import { OrchestrationDoc, WorkerDoc } from "./orchestration-state";
import { decodeRuntimeNotice } from "./runtime-notices";
import type { createWorkers } from "./orchestration-workers";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    release,
    wait: (ctx: Context) =>
      new Promise<void>((resolve, reject) => {
        const abort = () => reject(ctx.abortSignal!.reason);
        ctx.abortSignal!.addEventListener("abort", abort, { once: true });
        void promise.then(() => {
          ctx.abortSignal!.removeEventListener("abort", abort);
          resolve();
        });
      }),
  };
}

test.each(["queued-first", "await-first", "await-first-reopen"])(
  "repeated terminal await consumes the pending join (%s)",
  async (mode) => {
    const { faux, orchestration, open, registry } = await fixture();
    const childGate = gate();
    const repeatGate = gate();
    const notificationGate = gate();
    let repeating = false;
    let notificationReady = false;
    let childId: string;
    const subagent = orchestration.extension.tools!.find((tool) => tool.name === "subagent")!;
    const executeAwait = subagent.execute as (
      args: { action: "await"; sessionId: string },
      api: Parameters<typeof subagent.execute>[1],
      ctx: Parameters<typeof subagent.execute>[2],
    ) => ReturnType<typeof subagent.execute>;
    const waiter = orchestration.extension.tasks!.find(
      (task) => task.definition.name === "batty.await-child",
    ) as ReturnType<typeof createWorkers>["AwaitChild"];
    const wait = waiter.definition.phases.wait!;
    const pausedWait = vi
      .spyOn(waiter.definition.phases, "wait")
      .mockImplementation(async (...args) => {
        const [task, runtime, ctx] = args;
        await runtime.waitForTask(task.input.target, ctx);
        notificationReady = true;
        if (mode !== "queued-first") await notificationGate.wait(ctx);
        return wait(...args);
      });
    registry.install(
      defineExtension({
        name: "repeat-join-fixture",
        tools: [
          defineTool({
            name: "hold_child",
            description: "Hold the child until the parent awaits it",
            parameters: Type.Object({}),
            replay: "safe",
            execute: async (_, __, ctx) => {
              await childGate.wait(ctx);
              return { output: [{ type: "text", text: "child ready" }] };
            },
          }),
          defineTool({
            name: "repeat_join",
            description: "Repeat await after the child completes",
            parameters: Type.Object({}),
            replay: "safe",
            execute: async (_, api, ctx) => {
              repeating = true;
              await repeatGate.wait(ctx);
              return executeAwait({ action: "await", sessionId: childId }, api, ctx);
            },
          }),
        ],
      }),
    );
    const call = (name: string, args = {}) =>
      fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
    faux.setResponses(
      Array.from({ length: 30 }, () => (request) => {
        const last = request.messages.findLast((m) => m.role !== "system")!;
        const text = JSON.stringify(last.content);
        if (last.role === "user" && text.includes("launch repeated join"))
          return call("subagent", { action: "run", prompt: "outer repeated join" });
        if (last.role === "user" && text.includes("outer repeated join"))
          return call("subagent", { action: "run", prompt: "held repeated child" });
        if (last.role === "user" && text.includes("held repeated child")) return call("hold_child");
        if (last.role === "toolResult" && last.toolName === "hold_child")
          return fauxAssistantMessage([fauxText("unique child findings")]);
        if (last.role === "toolResult" && text.includes("Started. Session ID:"))
          return call("subagent", {
            action: "await",
            sessionId: text.match(/Session ID: (\d+)/)![1],
          });
        if (last.role === "user" && text.includes("repeat completed join"))
          return call("repeat_join");
        return fauxAssistantMessage([fauxText("parent final")]);
      }),
    );
    let { harness, main } = await open();
    try {
      await (
        await main.submit({ type: "input", content: "launch repeated join" }, context)
      ).wait(context);
      await until(async () => {
        const state = (await harness.snapshot(OrchestrationDoc, context))!;
        const child = Object.values(state.workers).find((w) => w.parentId !== main.id);
        if (!child?.active) return false;
        childId = String(child.id);
        return Boolean(
          (await harness.snapshot(WorkerDoc, child.parentId, context))?.completion?.waits[
            String(child.active)
          ],
        );
      });
      const child = Object.values(
        (await harness.snapshot(OrchestrationDoc, context))!.workers,
      ).find((w) => String(w.id) === childId)!;
      const parent = (await harness.conversation(child.parentId, context))!;
      const completion = (await harness.snapshot(WorkerDoc, parent.id, context))!.completion!;
      const waiterId = completion.waits[String(child.active)]!;
      await parent.submit({ type: "input", content: "repeat completed join" }, context);
      await until(async () => repeating);
      childGate.release();
      await until(async () => notificationReady);
      if (mode === "queued-first") await harness.waitForTask(waiterId, context);
      repeatGate.release();
      await until(async () =>
        (await parent.context(context)).messages.some(
          (message) =>
            message.role === "toolResult" &&
            JSON.stringify(message.content).includes("unique child findings"),
        ),
      );
      if (mode === "await-first-reopen") {
        await harness.close(context);
        ({ harness, main } = await open());
        harness.resume();
      }
      notificationGate.release();
      await until(async () => (await orchestration.listRunning()).length === 0);
      await main.waitForIdle(context);
      const messages = (await (await harness.conversation(parent.id, context))!.context(context))
        .messages;
      expect(
        messages.filter(
          (m) =>
            m.role === "toolResult" && JSON.stringify(m.content).includes("unique child findings"),
        ),
      ).toHaveLength(1);
      expect(
        messages.filter(
          (m) =>
            m.role === "user" &&
            decodeRuntimeNotice(m.content)?.text.includes("unique child findings"),
        ),
      ).toHaveLength(0);
      expect(messages.findLast((m) => m.role === "assistant")).toMatchObject({
        content: [fauxText("parent final")],
      });
    } finally {
      childGate.release();
      repeatGate.release();
      notificationGate.release();
      pausedWait.mockRestore();
    }
  },
  15000,
);
