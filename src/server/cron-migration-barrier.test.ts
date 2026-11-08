import { expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { OrchestrationDoc } from "./orchestration";
import { fixture, until } from "./orchestration-test-fixture";

test("migration closes future heartbeat admission without aborting its admitted run", async () => {
  const state = await fixture();
  const gates = Array.from({ length: 3 }, () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    return { promise, release: resolve, started: false };
  });
  let heartbeatStarts = 0;
  state.registry.install(
    defineExtension({
      name: "migration-barrier-test",
      tools: [
        defineTool({
          name: "migration_gate",
          description: "Hold admitted work until the test releases it",
          parameters: Type.Object({ observer: Type.Boolean() }),
          replay: "safe",
          execute: async ({ observer }, _, ctx) => {
            const gate = gates[observer ? 2 : heartbeatStarts++]!;
            gate.started = true;
            await new Promise<void>((resolve, reject) => {
              const abort = () => reject(ctx.abortSignal!.reason);
              ctx.abortSignal!.addEventListener("abort", abort, { once: true });
              void gate.promise.then(() => {
                ctx.abortSignal!.removeEventListener("abort", abort);
                resolve();
              });
            });
            return { output: [{ type: "text", text: "Work released" }] };
          },
        }),
      ],
    }),
  );
  const { main, harness } = await state.open();
  state.faux.setResponses(
    Array.from({ length: 8 }, () => (request) => {
      const last = request.messages.findLast((message) => message.role !== "system")!;
      if (last.role === "user")
        return fauxAssistantMessage(
          [
            fauxToolCall("migration_gate", {
              observer: JSON.stringify(last.content).includes("Read-only observer"),
            }),
          ],
          { stopReason: "toolUse" },
        );
      return fauxAssistantMessage([fauxText("Work completed")]);
    }),
  );
  try {
    const heartbeat = await state.orchestration.addJob({
      title: "Heartbeat",
      prompt: "Long-running heartbeat",
      enabled: false,
      delivery: "direct",
      schedule: { kind: "every", every: "1h" },
    });
    const observer = await state.orchestration.addJob({
      title: "Migration observer",
      prompt: "Read-only observer",
      enabled: false,
      delivery: "direct",
      schedule: { kind: "every", every: "1h" },
    });
    for (const job of [heartbeat, observer]) {
      await main.commit(async (tx) => {
        const current = (await tx.doc(OrchestrationDoc)).jobs[job.id]!;
        current.nextAt = Date.now() - 1000;
        current.enabled = true;
      }, context);
    }
    await state.orchestration.tick();
    // Both jobs must be executing, not merely present in the admission ledger.
    await until(async () => gates[0]!.started && gates[2]!.started);
    expect(await state.orchestration.listRunningCron()).toHaveLength(2);
    const admitted = (await state.orchestration.listRunningCron(heartbeat.id))[0]!;
    const original = await state.orchestration.getJob(heartbeat.id);
    await state.orchestration.updateJob(heartbeat.id, { enabled: false });
    await state.orchestration.removeJob(observer.id);
    for (const run of await state.orchestration.listRunningCron(observer.id)) {
      await state.orchestration.stopRunning(run.id);
    }
    harness.resume();
    await until(async () => (await state.orchestration.listRunningCron(observer.id)).length === 0);
    await main.commit(async (tx) => {
      (await tx.doc(OrchestrationDoc)).jobs[heartbeat.id]!.nextAt = Date.now() - 1000;
    }, context);
    await state.orchestration.tick();
    expect((await state.orchestration.listRunningCron(heartbeat.id)).map((run) => run.id)).toEqual([
      admitted.id,
    ]);
    expect(await state.orchestration.getJob(heartbeat.id)).toMatchObject({
      enabled: false,
      schedule: original.schedule,
      prompt: original.prompt,
    });
    // Drain the admitted work naturally; disabling admission must not abort it.
    gates[0]!.release();
    await until(async () => (await state.orchestration.listRunningCron(heartbeat.id)).length === 0);
    expect((await state.orchestration.listRunLogs(heartbeat.id))[0]).toMatchObject({
      id: admitted.id,
      status: "completed",
      output: "Work completed",
    });
    await state.orchestration.updateJob(heartbeat.id, { enabled: original.enabled });
    await state.orchestration.tick();
    await until(async () => gates[1]!.started);
    const restored = await state.orchestration.listRunningCron(heartbeat.id);
    expect(restored).toHaveLength(1);
    expect(restored[0]!.id).not.toBe(admitted.id);
    expect((await state.orchestration.getJob(heartbeat.id)).schedule).toEqual(original.schedule);
    gates[1]!.release();
    await until(async () => (await state.orchestration.listRunningCron(heartbeat.id)).length === 0);
  } finally {
    for (const gate of gates) gate.release();
  }
});
