import { expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";

import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTask, defineTool, LiveDoc } from "@earendil-works/pi-durable";

import { Type } from "@earendil-works/pi-ai";

import { OrchestrationDoc } from "./orchestration.js";
import { orchestrationHistory } from "./orchestration-test-history";

import { decodeRuntimeNotice } from "./runtime-notices.js";

import { fixture, until } from "./orchestration-test-fixture.js";

test.each(["complete", "restart", "cron-run", "cron-resume", "cron-restart"])(
  "worker await preserves its submission and target across %s",
  async (mode) => {
    const { faux, orchestration, open, registry } = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    registry.install(
      defineExtension({
        name: "nested-await-test",
        tools: [
          defineTool({
            name: "review_gate",
            description: "hold review open",
            parameters: Type.Object({}),
            replay: "safe",
            execute: async (_, __, ctx) => {
              await new Promise<void>((resolve, reject) => {
                const abort = () => reject(ctx.abortSignal!.reason);
                ctx.abortSignal!.addEventListener("abort", abort, { once: true });
                void gate.then(() => {
                  ctx.abortSignal!.removeEventListener("abort", abort);
                  resolve();
                });
              });
              return { output: [{ type: "text", text: "review ready" }] };
            },
          }),
        ],
      }),
    );
    let { harness, main } = await open();
    const successor = defineTask<null, { phase: "done" }, string>({
      name: "test.await-successor",
      version: 1,
      abort: async (_, runtime, ctx) => {
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
      },
      initial: () => ({ phase: "done" }),
      phases: {
        done: async (_, runtime, ctx) => {
          await runtime.commit(
            () => ({
              status: "terminal",
              outcome: { status: "completed", result: "unrelated successor result" },
            }),
            ctx,
          );
        },
      },
    });
    registry.install(defineExtension({ name: "await-successor-test", tasks: [successor] }));
    const call = (args: { action: string; async?: boolean; prompt?: string; sessionId?: string }) =>
      fauxAssistantMessage([fauxToolCall("subagent", args)], { stopReason: "toolUse" });
    faux.setResponses(
      Array.from({ length: 30 }, () => (request) => {
        const last = request.messages.findLast((m) => m.role !== "system")!;
        const text = JSON.stringify(last.content);
        if (last.role === "user" && text.includes("launch await test"))
          return call({ action: "run", async: true, prompt: "outer implementation" });
        if (last.role === "user" && text.includes("outer implementation"))
          return call({
            action: "run",
            async: true,
            prompt: mode === "cron-resume" ? "preflight review" : "nested review",
          });
        if (last.role === "user" && text.includes("preflight review"))
          return fauxAssistantMessage([fauxText("preflight complete")]);
        if (last.role === "toolResult" && text.includes("preflight complete")) {
          const sessionId = JSON.stringify(request.messages).match(/Session ID: (\d+)/)![1];
          return call({ action: "resume", async: true, sessionId, prompt: "nested review" });
        }
        if (last.role === "user" && text.includes("nested review"))
          return fauxAssistantMessage([fauxToolCall("review_gate", {})], { stopReason: "toolUse" });
        if (last.role === "toolResult" && text.includes("Started. Session ID:")) {
          const sessionId = text.match(/Session ID: (\d+)/)![1];
          return call({ action: "await", sessionId });
        }
        if (last.role === "toolResult" && last.toolName === "review_gate")
          return fauxAssistantMessage([fauxText("review findings")]);
        if (last.role === "toolResult" && text.includes("review findings"))
          return fauxAssistantMessage([fauxText("implementation final report after review")]);
        return fauxAssistantMessage([fauxText("noted")]);
      }),
    );
    try {
      if (mode.startsWith("cron-")) {
        const job = await orchestration.addJob({
          prompt: "outer implementation",
          session: { kind: "daily-detached" },
          schedule: { kind: "at", in: "1h" },
        });
        await main.commit(async (tx) => {
          (await tx.doc(OrchestrationDoc)).jobs[job.id]!.nextAt = Date.now() - 1;
        }, context);
        await orchestration.tick();
      } else {
        const submission = await main.submit(
          { type: "input", content: "launch await test" },
          context,
        );
        // Main await still yields, even though the nested review remains blocked.
        await submission.wait(context);
      }
      await until(async () => {
        const state = (await orchestrationHistory(harness))!;
        const outer = Object.values(state.workers).find((w) => w.parentId === main.id);
        if (!outer) return false;
        const live = await harness.snapshot(LiveDoc, outer.id, context);
        for (const slot of live?.tools ?? []) {
          if (slot.taskId && Object.values(state.joins ?? {}).includes(slot.taskId)) return true;
        }
        return false;
      });
      const pendingHistory = JSON.stringify((await main.context(context)).messages);
      expect(pendingHistory).not.toContain("implementation final report after review");
      expect(pendingHistory).not.toContain("review findings");
      if (mode.startsWith("cron-")) {
        expect(await orchestration.listRunningCron()).toHaveLength(1);
        expect((await orchestration.listRunningCron())[0]!.output).toBeUndefined();
      }
      if (mode.endsWith("restart")) {
        // Queue/resume replaces active with a later delivery. Recovery must keep
        // the target recorded by the already-running await, not follow this tail.
        await main.commit(async (tx) => {
          const state = await tx.doc(OrchestrationDoc);
          const inner = Object.values(state.workers).find((w) => w.parentId !== main.id)!;
          inner.active = await tx.createTask(successor, null, {
            ownership: { kind: "conversation" },
            background: true,
          });
        }, context);
        await harness.close(context);
        ({ harness, main } = await open());
        harness.resume();
      }
    } finally {
      release();
    }
    await until(async () => (await orchestration.listRunning()).length === 0);
    await main.waitForIdle(context);
    const state = (await orchestrationHistory(harness))!;
    const outer = Object.values(state.workers).find((w) => w.parentId === main.id)!;
    const history = (await main.context(context)).messages
      .map((message) =>
        message.role === "user"
          ? (decodeRuntimeNotice(message.content)?.text ?? message.content)
          : JSON.stringify(message),
      )
      .join("\n");
    expect(history).toContain(
      `[${mode.startsWith("cron-") ? "cron" : "subagent"} ${outer.id} result]\nimplementation final report after review`,
    );
    expect(history).not.toContain("review findings");
    expect(history).not.toContain("(no output)");
    const outerMessages = (await (await harness.conversation(outer.id, context))!.context(context))
      .messages;
    expect(
      outerMessages.filter(
        (m) => m.role === "user" && JSON.stringify(m.content).includes("review findings"),
      ),
    ).toHaveLength(0);
    expect(
      outerMessages.filter(
        (m) => m.role === "toolResult" && JSON.stringify(m.content).includes("review findings"),
      ),
    ).toHaveLength(1);
    expect(outerMessages.findLast((m) => m.role === "assistant")).toMatchObject({
      content: [{ type: "text", text: "implementation final report after review" }],
    });
  },
  15000,
);

test.each(
  [false, true].flatMap((awaitChild) => [false, true].map((fail) => ({ awaitChild, fail }))),
)(
  "worker delegation exposes session ID ($awaitChild, failed=$fail)",
  async ({ awaitChild, fail }) => {
    const { faux, orchestration, open } = await fixture(10000, () => {});
    const { harness, main } = await open();
    faux.setResponses(
      Array.from({ length: 25 }, () => (request) => {
        const last = request.messages.findLast((m) => m.role !== "system")!;
        const text = JSON.stringify(last.content);
        if (last.role === "user" && text.includes("launch sync preservation"))
          return fauxAssistantMessage(
            [fauxToolCall("subagent", { action: "run", prompt: "outer sync worker" })],
            { stopReason: "toolUse" },
          );
        if (last.role === "user" && text.includes("outer sync worker"))
          return fauxAssistantMessage(
            [
              fauxToolCall("subagent", {
                action: "run",
                async: awaitChild,
                prompt: "inner sync worker",
              }),
            ],
            { stopReason: "toolUse" },
          );
        if (last.role === "toolResult" && text.includes("Started. Session ID:"))
          return fauxAssistantMessage(
            [
              fauxToolCall("subagent", {
                action: "await",
                sessionId: text.match(/Session ID: (\d+)/)![1]!,
              }),
            ],
            { stopReason: "toolUse" },
          );
        if (last.role === "user" && text.includes("inner sync worker")) {
          if (fail) throw new Error("inner provider failure");
          return fauxAssistantMessage([fauxText("nested synchronous answer")]);
        }
        return fauxAssistantMessage([fauxText("outer completed")]);
      }),
    );
    await (
      await main.submit({ type: "input", content: "launch sync preservation" }, context)
    ).wait(context);
    await until(async () => (await orchestration.listRunning()).length === 0);
    const outer = Object.values((await orchestrationHistory(harness))!.workers).find(
      (w) => w.parentId === main.id,
    )!;
    const messages = (await (await harness.conversation(outer.id, context))!.context(context))
      .messages;
    const inner = Object.values((await orchestrationHistory(harness))!.workers).find(
      (w) => w.parentId === outer.id,
    )!;
    const result = messages.findLast((m) => m.role === "toolResult" && m.toolName === "subagent")!;
    expect(result.content).toEqual([
      {
        type: "text",
        text: fail
          ? `Subagent result. Session ID: ${inner.id}\n\nTask ${inner.id} failed: model_error`
          : `Subagent result. Session ID: ${inner.id}\n\nnested synchronous answer`,
      },
    ]);
    if (!awaitChild)
      expect(result).toMatchObject({
        details: { subagent: { async: false, respondIn: "tool-call" } },
      });
  },
  15000,
);
