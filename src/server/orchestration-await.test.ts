import { expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  defineExtension,
  defineTool,
  LiveDoc,
  GenerationTask,
  hook,
} from "@earendil-works/pi-durable";
import { WorkerDoc } from "./orchestration-state.js";
import { decodeRuntimeNotice } from "./runtime-notices.js";
import { fixture, until } from "./orchestration-test-fixture.js";
import { orchestrationHistory } from "./orchestration-test-history.js";

// Exercise actual model/tool boundaries, not just await's returned control.
test.each([
  "complete",
  "stop-child",
  "restart-stop-child",
  "stop-parent",
  "provider-failure",
  "boundary-steer",
  "registration-race",
  "stop-steering-parent",
])(
  "nested await remains steerable and keeps assignment completion separate: %s",
  async (mode) => {
    const { faux, orchestration, open, registry } = await fixture(10000, () => {});
    let release!: () => void;
    let gateAborted = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let boundaryPaused = false;
    let releaseBoundary!: () => void;
    const boundaryGate = new Promise<void>((resolve) => {
      releaseBoundary = resolve;
    });
    registry.install(
      defineExtension({
        name: "responsive-await-test",
        hooks: [
          hook(GenerationTask, {
            beforeRequest: async (request, _api, ctx) => {
              const input = JSON.stringify(
                request.messages.findLast((m) => m.role === "user")?.content,
              );
              if (
                !(
                  (mode === "boundary-steer" && input.includes("finish queued outer work")) ||
                  ((mode === "registration-race" || mode === "stop-steering-parent") &&
                    input.includes("inspect while child waits"))
                )
              )
                return;
              boundaryPaused = true;
              await new Promise<void>((resolve, reject) => {
                const abort = () => reject(ctx.abortSignal!.reason);
                ctx.abortSignal!.addEventListener("abort", abort, { once: true });
                void boundaryGate.then(() => {
                  ctx.abortSignal!.removeEventListener("abort", abort);
                  resolve();
                });
              });
            },
            onYield: async (answer, api, ctx) => {
              if (
                mode !== "boundary-steer" ||
                !JSON.stringify(answer.content).includes("outer final after necessary wait")
              )
                return;
              await (await harness.conversation(api.conversationId, ctx))!.submit(
                {
                  type: "input",
                  content: "finish queued outer work",
                  whenBusy: "steer",
                  requestId: "boundary-steering",
                },
                ctx,
              );
            },
          }),
        ],
        tools: [
          defineTool({
            name: "continue_round",
            description: "Continue after the tool round",
            parameters: Type.Object({}),
            execute: async () => ({ output: [{ type: "text", text: "continue outer request" }] }),
          }),
          defineTool({
            name: "hang_child",
            description: "Block child until released or cancelled",
            parameters: Type.Object({}),
            replay: "safe",
            execute: async (_, __, ctx) => {
              await new Promise<void>((resolve, reject) => {
                const abort = () => {
                  gateAborted = true;
                  reject(ctx.abortSignal!.reason);
                };
                ctx.abortSignal!.addEventListener("abort", abort, { once: true });
                void gate.then(() => {
                  ctx.abortSignal!.removeEventListener("abort", abort);
                  resolve();
                });
              });
              return { output: [{ type: "text", text: "child released" }] };
            },
          }),
        ],
      }),
    );
    let { harness, main } = await open();
    if (
      mode === "boundary-steer" ||
      mode === "registration-race" ||
      mode === "stop-steering-parent"
    )
      await main.configure(
        {
          extensions: [
            registry.snapshot().extension("responsive-await-test")!,
            orchestration.extension,
          ],
        },
        context,
      );
    let outerId = "";
    let childId = "";
    const call = (args: { action: string; prompt?: string; sessionId?: string }) =>
      fauxAssistantMessage([fauxToolCall("subagent", args)], { stopReason: "toolUse" });
    faux.setResponses(
      Array.from({ length: 80 }, () => (request) => {
        const last = request.messages.findLast((m) => m.role !== "system")!;
        const text = JSON.stringify(last.content);
        if (last.role === "user" && text.includes("launch responsive test"))
          return call({ action: "run", prompt: "outer responsive worker" });
        if (last.role === "user" && text.includes("outer responsive worker"))
          return call({ action: "run", prompt: "blocked responsive child" });
        if (last.role === "user" && text.includes("blocked responsive child"))
          return fauxAssistantMessage([fauxToolCall("hang_child", {})], { stopReason: "toolUse" });
        if (last.role === "toolResult" && text.includes("Started. Session ID:")) {
          const args = { action: "await", sessionId: text.match(/Session ID: (\d+)/)![1]! };
          if (
            mode === "provider-failure" &&
            request.messages.some(
              (m) =>
                m.role === "user" && JSON.stringify(m.content).includes("outer responsive worker"),
            )
          )
            return fauxAssistantMessage(
              [fauxToolCall("subagent", args), fauxToolCall("continue_round", {})],
              { stopReason: "toolUse" },
            );
          return call(args);
        }
        if (last.role === "toolResult" && last.toolName === "continue_round")
          throw new Error("outer provider failure with a pending join");
        if (last.role === "user" && text.includes("finish queued outer work"))
          return fauxAssistantMessage([fauxText("outer final after queued continuation")]);
        if (last.role === "user" && text.includes("send inspection steering"))
          return call({ action: "steer", sessionId: outerId, prompt: "inspect while child waits" });
        if (last.role === "user" && text.includes("inspect while child waits"))
          return fauxAssistantMessage([fauxText("interim inspection complete")]);
        if (last.role === "user" && text.includes("send child stop steering"))
          return call({ action: "steer", sessionId: outerId, prompt: "stop the hung child" });
        if (last.role === "user" && text.includes("stop the hung child"))
          return call({ action: "stop", sessionId: childId });
        if (last.role === "toolResult" && last.toolName === "hang_child")
          return fauxAssistantMessage([fauxText("child final answer")]);
        if (
          last.role === "user" &&
          (text.includes("Subagent aborted.") || text.includes("child final answer"))
        )
          return fauxAssistantMessage([fauxText("outer final after necessary wait")]);
        return fauxAssistantMessage([fauxText("acknowledged")]);
      }),
    );
    try {
      await (
        await main.submit({ type: "input", content: "launch responsive test" }, context)
      ).wait(context);
      await until(async () => {
        const workers = Object.values((await orchestrationHistory(harness))!.workers);
        const outer = workers.find((w) => w.prompt === "outer responsive worker");
        const child = workers.find((w) => w.prompt === "blocked responsive child");
        if (!outer || !child) return false;
        outerId = String(outer.id);
        childId = String(child.id);
        const metadata = await harness.snapshot(WorkerDoc, outer.id, context);
        return (
          Object.keys(metadata?.completion?.waits ?? {}).length === 1 &&
          !(await harness.snapshot(LiveDoc, outer.id, context))?.run
        );
      });
      if (mode === "restart-stop-child") {
        await harness.close(context);
        ({ harness, main } = await open());
        harness.resume();
        gateAborted = false;
      }
      if (mode === "stop-parent") {
        await orchestration.stopWorker(outerId);
        release();
        await until(async () => (await orchestration.listRunning()).length === 0);
        const history = JSON.stringify((await main.context(context)).messages);
        expect(history).not.toContain("outer final after necessary wait");
        expect(history).not.toContain(`[subagent ${outerId} result]`);
        const completion = (await harness.snapshot(WorkerDoc, Number(outerId) as never, context))
          ?.completion;
        expect(completion).toBeUndefined();
        return;
      }
      await (
        await main.submit({ type: "input", content: "send inspection steering" }, context)
      ).wait(context);
      if (mode === "stop-steering-parent") {
        await until(async () => boundaryPaused);
        await orchestration.stopWorker(outerId);
        await until(
          async () => !(await harness.snapshot(LiveDoc, Number(outerId) as never, context))?.run,
        );
        release();
        await until(async () => (await orchestration.listRunning()).length === 0);
        expect(JSON.stringify((await main.context(context)).messages)).not.toContain(
          `[subagent ${outerId} result]`,
        );
        return;
      }
      if (mode === "registration-race") {
        await until(async () => boundaryPaused);
        release();
        await until(async () => {
          const completion = (await harness.snapshot(WorkerDoc, Number(outerId) as never, context))!
            .completion!;
          for (const waiter of Object.values(completion.waits))
            if ((await harness.getTask(waiter, context))?.state.status !== "terminal") return false;
          return true;
        });
        expect(JSON.stringify((await main.context(context)).messages)).not.toContain(
          `[subagent ${outerId} result]`,
        );
        releaseBoundary();
      }
      await until(async () =>
        JSON.stringify(
          (await (await harness.conversation(Number(outerId) as never, context))!.context(context))
            .messages,
        ).includes("interim inspection complete"),
      );
      expect(JSON.stringify((await main.context(context)).messages)).not.toContain(
        "interim inspection complete",
      );
      if (mode !== "registration-race")
        expect((await orchestration.listRunning()).some((w) => w.sessionId === outerId)).toBe(true);
      if (
        mode === "complete" ||
        mode === "provider-failure" ||
        mode === "boundary-steer" ||
        mode === "registration-race"
      )
        release();
      else {
        await (
          await main.submit({ type: "input", content: "send child stop steering" }, context)
        ).wait(context);
        await until(async () => gateAborted);
      }
      if (mode === "boundary-steer") {
        await until(async () => boundaryPaused);
        // The queued run exists but its request hook has not registered input.
        expect(JSON.stringify((await main.context(context)).messages)).not.toContain(
          `[subagent ${outerId} result]`,
        );
        releaseBoundary();
      }
      await until(async () => (await orchestration.listRunning()).length === 0);
      await main.waitForIdle(context);
      const notices = (await main.context(context)).messages.flatMap((message) =>
        message.role === "user" ? [decodeRuntimeNotice(message.content)?.text ?? ""] : [],
      );
      expect(notices.filter((text) => text.includes(`[subagent ${outerId} result]`))).toEqual([
        `[subagent ${outerId} result]\n${mode === "boundary-steer" ? "outer final after queued continuation" : "outer final after necessary wait"}`,
      ]);
    } finally {
      release();
      releaseBoundary();
    }
  },
  15000,
);
