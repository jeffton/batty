import Fastify from "fastify";
import { expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { fixture, until } from "./orchestration-test-fixture";
import { OrchestrationDoc } from "./orchestration";
import { registerCronRoutes } from "./routes/cron";

test("API creates, replaces and imports multiple triggers with persistent per-trigger deadlines", async () => {
  const { orchestration, open } = await fixture();
  await open();
  const app = Fastify();
  registerCronRoutes(app, orchestration);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/cron",
      payload: {
        action: "add",
        title: "Checks",
        prompt: "Shared task",
        enabled: false,
        schedule: {
          kind: "multiple",
          triggers: [
            { kind: "at", in: "1h" },
            { kind: "every", every: "2h" },
            { kind: "cron", expression: "0 10 * * *", timezone: "Europe/Stockholm" },
          ],
        },
      },
    });
    expect(response.statusCode).toBe(200);
    const job = response.json();
    expect(job.schedule.triggers).toHaveLength(3);
    expect(job.nextAt).toBe(
      Math.min(...job.schedule.triggers.map((trigger: { nextAt: number }) => trigger.nextAt)),
    );
    const nextBefore = job.nextAt;
    await orchestration.updateJob(job.id, { title: "Renamed" });
    expect((await orchestration.getJob(job.id)).nextAt).toBe(nextBefore);
    const exported = await orchestration.getJob(job.id);
    await orchestration.removeJob(job.id);
    expect(await orchestration.importJob(exported)).toEqual(exported);
    await expect(
      orchestration.importJob({ ...exported, id: "bad", nextAt: exported.nextAt! + 1 }),
    ).rejects.toThrow("earliest");
    const replaced = await orchestration.updateJob(job.id, {
      schedule: {
        kind: "multiple",
        triggers: [
          { kind: "at", in: "3h" },
          { kind: "at", in: "4h" },
        ],
      },
    });
    expect(replaced.nextAt).toBeGreaterThan(nextBefore);
    expect(replaced.schedule.kind).toBe("multiple");
    if (replaced.schedule.kind === "multiple") expect(replaced.schedule.triggers).toHaveLength(2);
  } finally {
    await app.close();
  }
});

test("exhausted finite cron triggers disable the job and remain importable", async () => {
  const { orchestration, open, faux } = await fixture();
  await open();
  faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage([fauxText("done")])));
  const due = Date.parse("2020-01-01T00:00:00Z");
  const job = await orchestration.importJob({
    id: "finite-cron",
    title: "Final check",
    workspaceId: "test",
    prompt: "Check",
    enabled: false,
    schedule: {
      kind: "multiple",
      triggers: [
        { kind: "cron", expression: "0 0 0 1 1 * 2020", timezone: "UTC", nextAt: due },
        { kind: "cron", expression: "0 0 0 1 1 * 2020", timezone: "UTC", nextAt: due },
      ],
    },
    nextAt: due,
    createdAt: due - 1000,
    updatedAt: due - 1000,
  });
  await orchestration.updateJob(job.id, { enabled: true });
  await orchestration.tick();
  await until(async () => (await orchestration.listRunLogs(job.id))[0]?.status === "completed");
  const exported = await orchestration.getJob(job.id);
  expect(exported.enabled).toBe(false);
  expect(exported).not.toHaveProperty("nextAt");
  await orchestration.removeJob(job.id);
  expect(await orchestration.importJob(exported)).toEqual(exported);
});

test("AI tool accepts mixed triggers as a single scheduled task", async () => {
  const { orchestration, open, faux } = await fixture();
  const { main } = await open();
  const cron = orchestration.extension.tools!.find((tool) => tool.name === "cron")!;
  await main.configure({ extensions: [orchestration.extension], tools: [cron] }, context);
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("cron", {
          action: "add",
          title: "Follow-up",
          prompt: "One shared task",
          schedule: {
            kind: "multiple",
            triggers: [
              { kind: "at", in: "1h" },
              { kind: "every", every: "1d" },
            ],
          },
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("Scheduled.")]),
  ]);
  await (
    await main.submit({ type: "input", content: "Schedule follow-up" }, context)
  ).wait(context);
  const jobs = await orchestration.listJobs();
  expect(jobs).toHaveLength(1);
  expect(jobs[0]!.schedule.kind).toBe("multiple");
});

test("coincident one-shots run once and retire after successful completion", async () => {
  const { orchestration, open, faux } = await fixture();
  await open();
  faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage([fauxText("done")])));
  const due = Date.now() - 1000;
  const job = await orchestration.importJob({
    id: "one-shots",
    title: "Checks",
    workspaceId: "test",
    prompt: "Run once",
    enabled: false,
    schedule: {
      kind: "multiple",
      triggers: [0, 0, -1000].map((offset) => ({
        kind: "at",
        at: new Date(due + offset).toISOString(),
        nextAt: due + offset,
      })),
    },
    nextAt: due - 1000,
    createdAt: due - 2000,
    updatedAt: due - 2000,
  });
  await orchestration.updateJob(job.id, { enabled: true });
  await orchestration.tick();
  await until(async () => (await orchestration.listRunLogs(job.id))[0]?.status === "completed");
  await orchestration.tick();
  expect(await orchestration.listJobs()).toEqual([]);
  const runs = await orchestration.listRunLogs(job.id);
  expect(runs).toHaveLength(1);
  expect(runs[0]!.job?.schedule.kind).toBe("multiple");
});

test("one-shot plus recurring survives reopen without replaying the consumed one-shot", async () => {
  const state = await fixture();
  let { harness, main } = await state.open();
  state.faux.setResponses(
    Array.from({ length: 20 }, () => fauxAssistantMessage([fauxText("done")])),
  );
  const due = Date.now() - 1000;
  const recurringDeadline = due + 3600000;
  const job = await state.orchestration.importJob({
    id: "mixed",
    title: "Checks",
    workspaceId: "test",
    prompt: "Shared state",
    enabled: false,
    schedule: {
      kind: "multiple",
      triggers: [
        { kind: "at", at: new Date(due).toISOString(), nextAt: due },
        { kind: "every", every: "1h", everyMs: 3600000, nextAt: recurringDeadline },
      ],
    },
    nextAt: due,
    createdAt: due - 1000,
    updatedAt: due - 1000,
  });
  await state.orchestration.updateJob(job.id, { enabled: true });
  await state.orchestration.tick();
  await until(
    async () => (await state.orchestration.listRunLogs(job.id))[0]?.status === "completed",
  );
  await main.waitForIdle(context);
  const after = await state.orchestration.getJob(job.id);
  expect(after.enabled).toBe(true);
  expect(after.nextAt).toBe(recurringDeadline);
  expect(after.schedule).toMatchObject({
    kind: "multiple",
    triggers: [{ kind: "at", at: new Date(due).toISOString() }, { nextAt: recurringDeadline }],
  });
  if (after.schedule.kind === "multiple")
    expect(after.schedule.triggers[0]).not.toHaveProperty("nextAt");
  state.orchestration.close();
  await harness.close(context);
  ({ harness, main } = await state.open());
  await state.orchestration.tick();
  expect(await state.orchestration.listRunLogs(job.id)).toHaveLength(1);
  expect(await state.orchestration.getJob(job.id)).toEqual(after);
  // Make just the recurring trigger due and admit it through the actual scheduler.
  const secondDue = Date.now() - 1000;
  await main.commit(async (tx) => {
    const current = (await tx.doc(OrchestrationDoc)).jobs[job.id]!;
    if (current.schedule.kind !== "multiple") throw new Error("Expected multiple schedule");
    current.schedule.triggers[1]!.nextAt = secondDue;
    current.nextAt = secondDue;
  }, context);
  await state.orchestration.tick();
  await until(
    async () =>
      (await state.orchestration.listRunLogs(job.id)).filter((run) => run.status === "completed")
        .length === 2,
  );
  expect((await state.orchestration.getJob(job.id)).nextAt).toBe(secondDue + 3600000);
});
