import { expect, test, vi } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { fileArtifactRef, siteArtifactRef } from "@/shared/artifacts";
import { Type } from "typebox";
import { fixture, until, withAttachments } from "./orchestration-test-fixture";
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

test.each(["queued-first", "await-first", "await-first-reopen", "notice-first"])(
  "a completed child presents its files and sites exactly once (%s)",
  async (mode) => {
    const file = {
      id: "joined-file",
      name: "Report.pdf",
      storedPath: "/tmp/joined/Report.pdf",
      size: 1,
      mimeType: "application/pdf",
      kind: "file" as const,
      downloadUrl: "/api/sent-files/joined-file",
    };
    const site = {
      kind: "site" as const,
      id: "joined-site",
      name: "Joined result",
      url: "/joined-site",
      public: false as const,
    };
    const artifactRefs = [fileArtifactRef(file.id), siteArtifactRef(site.id)];
    const presentation = { sentFiles: [file], sites: [site] };
    const { faux, orchestration, open, registry } = await fixture(
      10_000,
      console.error,
      undefined,
      undefined,
      async (_, selection) => {
        expect(selection.artifactRefs).toEqual(artifactRefs);
        return presentation;
      },
    );
    const childGate = gate();
    const repeatGate = gate();
    const notificationGate = gate();
    let repeating = false;
    let notificationReady = false;
    let childId: string;
    const subagent = orchestration.extension.tools!.find((tool) => tool.name === "subagent")!;
    const execute = subagent.execute as (
      command: { action: string; sessionId?: string },
      api: Parameters<typeof subagent.execute>[1],
      ctx: Context,
    ) => ReturnType<typeof subagent.execute>;
    const pausedAwait = vi
      .spyOn(subagent, "execute")
      .mockImplementation(
        async (
          command: Parameters<typeof execute>[0],
          api: Parameters<typeof execute>[1],
          ctx: Context,
        ) => {
          if (
            command.action === "await" &&
            command.sessionId === childId &&
            mode !== "notice-first"
          ) {
            repeating = true;
            await repeatGate.wait(ctx);
          }
          return execute(command, api, ctx);
        },
      );
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
        if (mode.startsWith("await-first")) await notificationGate.wait(ctx);
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
          return fauxAssistantMessage([
            fauxText(withAttachments("unique child findings", { artifactRefs })),
          ]);
        if (last.role === "toolResult" && text.includes("Started. Session ID:"))
          return call("subagent", {
            action: "await",
            sessionId: text.match(/Session ID: (\d+)/)![1],
          });
        if (
          last.role === "user" &&
          (text.includes("repeat completed join") || text.includes("unique child findings"))
        )
          return call("subagent", { action: "await", sessionId: childId });
        if (
          last.role === "toolResult" &&
          text.includes("unique child findings") &&
          request.messages.filter(
            (message) =>
              message.role === "toolResult" &&
              JSON.stringify(message.content).includes("unique child findings"),
          ).length === 1
        )
          return call("subagent", { action: "await", sessionId: childId });
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
        const waiting = (await harness.snapshot(WorkerDoc, child.parentId, context))?.completion
          ?.waits[String(child.active)];
        if (!waiting) return false;
        childId = String(child.id);
        return true;
      });
      const child = Object.values(
        (await harness.snapshot(OrchestrationDoc, context))!.workers,
      ).find((w) => String(w.id) === childId)!;
      const parent = (await harness.conversation(child.parentId, context))!;
      const completion = (await harness.snapshot(WorkerDoc, parent.id, context))!.completion!;
      const waiterId = completion.waits[String(child.active)]!;
      if (mode !== "notice-first") {
        await parent.submit({ type: "input", content: "repeat completed join" }, context);
        await until(async () => repeating);
      }
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
      const presentations = messages.flatMap((m) =>
        m.role === "toolResult" &&
        m.toolName === "subagent" &&
        JSON.stringify(m.content).includes("unique child findings")
          ? [m.details]
          : [],
      );
      expect(presentations).toEqual(mode === "notice-first" ? [{}, {}] : [{ presentation }, {}]);
      const notices = messages.flatMap((m) => {
        const notice = m.role === "user" ? decodeRuntimeNotice(m.content) : undefined;
        return notice?.text.includes("unique child findings") ? [notice] : [];
      });
      expect(notices.map((notice) => notice.data?.runtimePresentation)).toEqual(
        mode === "notice-first" ? [presentation] : [],
      );
      const reply = messages.findLast((m) => m.role === "assistant");
      expect(reply).toMatchObject({ content: [fauxText("parent final")] });
      expect(reply).not.toHaveProperty("battyPresentation");
      const finalNotice = (await main.context(context)).messages
        .flatMap((m) => (m.role === "user" ? [decodeRuntimeNotice(m.content)] : []))
        .find((notice) => notice?.text.includes("parent final"));
      expect(finalNotice).toBeDefined();
      expect(finalNotice?.data?.runtimePresentation).toBeUndefined();
    } finally {
      childGate.release();
      repeatGate.release();
      notificationGate.release();
      pausedWait.mockRestore();
      pausedAwait.mockRestore();
    }
  },
  15000,
);
