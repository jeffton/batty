import { expect, test } from "vite-plus/test";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { artifactRefs, createAttachArtifactsTool } from "./artifact-forwarding";
import { decodeRuntimeNotice } from "./runtime-notices";
import { fixture, until } from "./orchestration-test-fixture";
import { orchestrationHistory } from "./orchestration-test-history";

const artifacts = {
  sentFiles: [
    {
      id: "report-file",
      name: "report.png",
      storedPath: "/tmp/report.png",
      size: 1,
      mimeType: "image/png",
      kind: "image" as const,
      downloadUrl: "/api/sent-files/report-file",
    },
  ],
  fileChanges: [{ path: "report.ts", patch: "immutable patch" }],
  sites: [
    {
      kind: "site" as const,
      id: "report-site",
      name: "Report site",
      url: "/site",
      public: false as const,
    },
    {
      kind: "browser" as const,
      id: "report-browser",
      browserId: "same-live-browser",
      name: "Browser",
      url: "/browser",
      public: false as const,
    },
  ],
};

test.each([false, true])(
  "nonterminal report forwards artifacts only to actual parent (nested=%s)",
  async (nested) => {
    const { faux, orchestration, open, registry } = await fixture();
    let release!: () => void;
    let continued = false;
    let forwarded = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    registry.install(
      defineExtension({
        name: "progress-fixture",
        tools: [
          createAttachArtifactsTool(),
          defineTool({
            name: "attach-progress",
            description: "Attach all artifact kinds",
            parameters: Type.Object({}),
            execute: async () => ({
              output: [{ type: "text", text: "attached progress" }],
              details: artifacts as unknown as JsonValue,
            }),
          }),
          defineTool({
            name: "continue-working",
            description: "Continue after reporting",
            parameters: Type.Object({}),
            replay: "safe",
            execute: async (_, __, ctx) => {
              continued = true;
              await new Promise<void>((resolve, reject) => {
                const abort = () => reject(ctx.abortSignal!.reason);
                ctx.abortSignal!.addEventListener("abort", abort, { once: true });
                void gate.then(() => {
                  ctx.abortSignal!.removeEventListener("abort", abort);
                  resolve();
                });
              });
              return { output: [{ type: "text", text: "continued work complete" }] };
            },
          }),
        ],
      }),
    );
    const { harness, main } = await open();
    const call = (name: string, args: Record<string, JsonValue>) =>
      fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
    faux.setResponses(
      Array.from({ length: 40 }, () => (request) => {
        const last = request.messages.findLast((m) => m.role !== "system")!;
        const text = JSON.stringify(last.content);
        if (last.role === "user" && text.includes("launch progress"))
          return call("subagent", {
            action: "run",
            prompt: nested ? "outer assignment" : "inner assignment",
            workspaceId: "other",
          });
        if (last.role === "user" && text.includes("outer assignment"))
          return call("subagent", {
            action: "run",
            prompt: "inner assignment",
            async: true,
            workspaceId: "test",
          });
        if (last.role === "user" && text.includes("inner assignment"))
          return call("attach-progress", {});
        if (last.role === "toolResult" && last.toolName === "attach-progress")
          return call("subagent", { action: "report", prompt: "intermediate evidence" });
        if (last.role === "toolResult" && text.includes("Reported to parent"))
          return call("continue-working", {});
        if (last.role === "toolResult" && last.toolName === "continue-working")
          return fauxAssistantMessage([fauxText("inner final")]);
        if (last.role === "user" && text.includes("intermediate evidence"))
          return call("attach_artifacts", {
            refs: artifactRefs(artifacts).map((item) => item.ref),
          });
        if (last.role === "toolResult" && last.toolName === "attach_artifacts") {
          forwarded = true;
          return fauxAssistantMessage([fauxText("progress acknowledged")]);
        }
        if (
          last.role === "toolResult" &&
          text.includes("Started. Session ID:") &&
          nested &&
          request.messages.some(
            (m) => m.role === "user" && JSON.stringify(m.content).includes("outer assignment"),
          )
        )
          return call("subagent", {
            action: "await",
            sessionId: text.match(/Session ID: (\d+)/)![1]!,
          });
        if (text.includes("inner final")) return fauxAssistantMessage([fauxText("outer final")]);
        return fauxAssistantMessage([fauxText("acknowledged")]);
      }),
    );
    try {
      await (
        await main.submit({ type: "input", content: "launch progress" }, context)
      ).wait(context);
      await until(async () => continued && forwarded);
      const state = (await orchestrationHistory(harness))!;
      const child = Object.values(state.workers).find(
        (worker) => worker.prompt === "inner assignment",
      )!;
      expect((await harness.getTask(child.active!, context))!.state.status).not.toBe("terminal");
      const parent = (await harness.conversation(child.parentId, context))!;
      const notices = (await parent.context(context)).messages.flatMap((message) =>
        message.role === "user" ? [decodeRuntimeNotice(message.content)] : [],
      );
      const progress = notices.filter((notice) =>
        notice?.text.startsWith(`[subagent ${child.id} report]`),
      );
      expect(progress).toHaveLength(1);
      expect(progress[0]!.data!.runtimeResultArtifacts).toEqual(artifacts);
      const forwardedResult = (await parent.context(context)).messages.findLast(
        (message) => message.role === "toolResult" && message.toolName === "attach_artifacts",
      );
      expect(forwardedResult?.role === "toolResult" && forwardedResult.details).toMatchObject({
        forwardedArtifacts: artifacts,
      });
      if (nested) {
        expect(JSON.stringify((await main.context(context)).messages)).not.toContain(
          "intermediate evidence",
        );
        expect(child.workspaceId).toBe("test");
        expect(
          Object.values(state.workers).find((worker) => worker.id === child.parentId)!.workspaceId,
        ).toBe("other");
      }
    } finally {
      release();
    }
    await until(async () => (await orchestration.listRunning()).length === 0);
    await main.waitForIdle(context);
    const history = JSON.stringify((await main.context(context)).messages);
    expect(history).toContain(nested ? "outer final" : "inner final");
  },
);

test("main cannot send a report or select an arbitrary recipient", async () => {
  const { faux, open } = await fixture();
  const { main } = await open();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("subagent", { action: "report", prompt: "invalid" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(
      [fauxToolCall("subagent", { action: "report", prompt: "invalid", sessionId: "123" })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("done")]),
  ]);
  await (
    await main.submit({ type: "input", content: "try invalid report" }, context)
  ).wait(context);
  const messages = JSON.stringify((await main.context(context)).messages);
  expect(messages).toContain("Only an assigned subagent");
  expect(messages).toContain("omit sessionId");
  expect(messages).not.toContain("[subagent");
});
