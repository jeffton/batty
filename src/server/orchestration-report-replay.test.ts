import { expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { decodeRuntimeNotice } from "./runtime-notices";
import { fixture, until } from "./orchestration-test-fixture";
import { OrchestrationDoc, WorkerDoc } from "./orchestration-state";

test("report accepted before tool settlement is delivered once across restart", async () => {
  const { faux, orchestration, open, registry } = await fixture();
  const subagent = orchestration.extension.tools!.find((tool) => tool.name === "subagent")!;
  const executeReport = subagent.execute as (
    args: { action: "report"; prompt: string },
    api: Parameters<typeof subagent.execute>[1],
    ctx: Parameters<typeof subagent.execute>[2],
  ) => ReturnType<typeof subagent.execute>;
  let delivered = false;
  let executions = 0;
  registry.install(
    defineExtension({
      name: "report-replay-fixture",
      tools: [
        defineTool({
          name: "report-and-interrupt",
          description: "Report then interrupt before tool settlement",
          parameters: Type.Object({}),
          replay: "safe",
          execute: async (_, api, ctx) => {
            executions++;
            const result = await executeReport(
              { action: "report", prompt: "durable progress" },
              api,
              ctx,
            );
            if (!delivered) {
              delivered = true;
              await new Promise<void>((_, reject) => {
                ctx.abortSignal!.addEventListener("abort", () => reject(ctx.abortSignal!.reason), {
                  once: true,
                });
              });
            }
            return result;
          },
        }),
      ],
    }),
  );
  let { harness, main } = await open();
  faux.setResponses(
    Array.from({ length: 20 }, () => (request) => {
      const last = request.messages.findLast((m) => m.role !== "system")!;
      const text = JSON.stringify(last.content);
      if (last.role === "user" && text.includes("launch replay"))
        return fauxAssistantMessage(
          [fauxToolCall("subagent", { action: "run", prompt: "replay assignment" })],
          { stopReason: "toolUse" },
        );
      if (last.role === "user" && text.includes("replay assignment"))
        return fauxAssistantMessage([fauxToolCall("report-and-interrupt", {})], {
          stopReason: "toolUse",
        });
      if (last.role === "toolResult" && last.toolName === "report-and-interrupt")
        return fauxAssistantMessage([fauxText("replay final")]);
      return fauxAssistantMessage([fauxText("acknowledged")]);
    }),
  );
  await (await main.submit({ type: "input", content: "launch replay" }, context)).wait(context);
  await until(async () => delivered);
  const worker = Object.values((await harness.snapshot(OrchestrationDoc, context))!.workers)[0]!;
  const report = (await harness.snapshot(WorkerDoc, worker.id, context))!.latestReport;
  expect(report?.text).toBe("durable progress");
  await harness.close(context);
  ({ harness, main } = await open());
  harness.resume();
  await until(async () => (await orchestration.listRunning()).length === 0);
  await main.waitForIdle(context);
  expect(executions).toBe(2);
  const metadata = (await harness.snapshot(WorkerDoc, worker.id, context))!;
  expect(metadata.latestReport).toEqual(report);
  expect(metadata.latestResultAssignment).toBe(worker.active);
  const notices = (await main.context(context)).messages.flatMap((message) =>
    message.role === "user" ? [decodeRuntimeNotice(message.content)] : [],
  );
  expect(notices.filter((notice) => notice?.text.includes("durable progress"))).toHaveLength(1);
  expect(notices.filter((notice) => notice?.text.includes("replay final"))).toHaveLength(1);
});
