import { expect, test } from "vite-plus/test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { fixture, until } from "./orchestration-test-fixture.js";

test("native cron drains admitted work and leaves scheduler state intact", async () => {
  const state = await fixture(10000);
  await state.open();
  state.faux.setResponses(
    Array.from({ length: 2 }, () => fauxAssistantMessage([fauxText("finished normally")])),
  );
  const now = Date.now();
  const heartbeat = await state.orchestration.importJob({
    id: "uid-handoff-heartbeat",
    title: "Heartbeat",
    workspaceId: "test",
    prompt: "Heartbeat prompt",
    delivery: "assistant",
    enabled: true,
    schedule: { kind: "every", every: "1h", everyMs: 3_600_000 },
    createdAt: now - 10_000,
    updatedAt: now - 10_000,
    nextAt: now - 1_000,
  });
  const oneShot = await state.orchestration.importJob({
    id: "uid-handoff-one-shot",
    title: "Independent one-shot",
    workspaceId: "test",
    prompt: "One-shot prompt",
    delivery: "assistant",
    enabled: true,
    schedule: { kind: "at", at: new Date(now - 1_000).toISOString() },
    createdAt: now - 10_000,
    updatedAt: now - 10_000,
    nextAt: now - 1_000,
  });
  const retry = await state.orchestration.importJob({
    id: "uid-handoff-retry",
    title: "Unrelated disabled retry",
    workspaceId: "test",
    prompt: "Must remain untouched",
    delivery: "assistant",
    enabled: false,
    schedule: { kind: "every", every: "1h", everyMs: 3_600_000 },
    createdAt: now - 20_000,
    updatedAt: now - 20_000,
    nextAt: now + 3_600_000,
    retryAt: now + 60_000,
  });

  await state.orchestration.tick();
  await until(async () => (await state.orchestration.listRunningCron()).length === 2);
  await until(async () => {
    const runs = await state.orchestration.listRunLogs();
    return runs.length === 2 && runs.every((run) => run.status === "completed");
  });

  const heartbeatAfterRun = await state.orchestration.getJob(heartbeat.id);
  expect(heartbeatAfterRun).toMatchObject({
    enabled: true,
    prompt: heartbeat.prompt,
    schedule: heartbeat.schedule,
    updatedAt: heartbeat.updatedAt,
  });
  expect(heartbeatAfterRun.nextAt).toBeGreaterThan(heartbeat.nextAt!);
  expect(await state.orchestration.getJob(retry.id)).toEqual(retry);
  await expect(state.orchestration.getJob(oneShot.id)).rejects.toThrow("Unknown cron job");
  expect((await state.orchestration.listRunLogs()).map((run) => run.status)).toEqual([
    "completed",
    "completed",
  ]);

  await Promise.all([state.orchestration.tick(), state.orchestration.tick()]);
  expect(await state.orchestration.listRunLogs()).toHaveLength(2);
  expect(await state.orchestration.getJob(retry.id)).toEqual(retry);
});
