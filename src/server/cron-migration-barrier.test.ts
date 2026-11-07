import { expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { OrchestrationDoc } from "./orchestration";
import { fixture, until } from "./orchestration-test-fixture";

test("migration closes future heartbeat admission without aborting its admitted run", async () => {
  const state = await fixture(1);
  const { main, harness } = await state.open();
  state.faux.setResponses([
    fauxAssistantMessage([fauxText("Work in progress. ".repeat(1000))]),
    fauxAssistantMessage([fauxText("Observer in progress. ".repeat(1000))]),
    fauxAssistantMessage([fauxText("Restored heartbeat. ".repeat(1000))]),
  ]);
  const heartbeat = await state.orchestration.addJob({
    title: "Heartbeat",
    prompt: "Long-running heartbeat",
    enabled: false,
    schedule: { kind: "every", every: "1h" },
  });
  const observer = await state.orchestration.addJob({
    title: "Migration observer",
    prompt: "Read-only observer",
    enabled: false,
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
  await until(async () => (await state.orchestration.listRunningCron()).length === 2);
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
  // Finish the admitted work, then reopen admission on the authoritative host.
  await state.orchestration.stopRunning(admitted.id);
  harness.resume();
  await until(async () => (await state.orchestration.listRunningCron(heartbeat.id)).length === 0);
  await state.orchestration.updateJob(heartbeat.id, { enabled: original.enabled });
  await state.orchestration.tick();
  await until(async () => (await state.orchestration.listRunningCron(heartbeat.id)).length === 1);
  expect((await state.orchestration.getJob(heartbeat.id)).schedule).toEqual(original.schedule);
});
