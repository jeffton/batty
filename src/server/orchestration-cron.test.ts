import { expect, test, vi } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";

import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

import { OrchestrationDoc, type CronRun } from "./orchestration.js";

import { indexRun } from "./orchestration-history";

import { fixture, until } from "./orchestration-test-fixture.js";

test("offline cron preserves due deadlines across reopen and coalesces missed triggers on recovery", async () => {
  let online = false;
  const check = vi.fn(async () => online);
  const state = await fixture(10000, console.error, undefined, check);
  let { harness } = await state.open();
  const now = Date.now();
  const deadline = now - 3 * 60_000;
  for (const id of ["one-shot", "recurring"]) {
    await state.orchestration.importJob({
      id,
      title: id,
      workspaceId: "test",
      prompt: id,
      delivery: "direct",
      enabled: true,
      schedule:
        id === "one-shot"
          ? { kind: "at", at: new Date(deadline).toISOString() }
          : { kind: "every", every: "1m", everyMs: 60_000 },
      nextAt: deadline,
      createdAt: now - 5 * 60_000,
      updatedAt: now - 5 * 60_000,
    });
  }
  await state.orchestration.tick();
  await state.orchestration.tick();
  expect(check).toHaveBeenCalledTimes(1);
  expect(await state.orchestration.listRunLogs()).toEqual([]);
  expect((await state.orchestration.listJobs()).map((j) => j.nextAt)).toEqual([deadline, deadline]);
  state.orchestration.close();
  await harness.close(context);
  ({ harness } = await state.open());
  expect((await state.orchestration.listJobs()).map((j) => j.nextAt)).toEqual([deadline, deadline]);
  online = true;
  state.faux.setResponses(
    Array.from({ length: 2 }, () => fauxAssistantMessage([fauxText("done")])),
  );
  const clock = vi.spyOn(Date, "now").mockReturnValue(now + 31_000);
  try {
    await Promise.all([state.orchestration.tick(), state.orchestration.tick()]);
    await until(
      async () =>
        (await state.orchestration.listRunLogs()).filter((r) => r.status === "completed").length ===
        2,
    );
    const runs = await state.orchestration.listRunLogs();
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.scheduledAt)).toEqual([deadline, deadline]);
    expect((await state.orchestration.getJob("recurring")).nextAt).toBeGreaterThan(now + 31_000);
    await state.orchestration.tick();
    expect(await state.orchestration.listRunLogs()).toHaveLength(2);
  } finally {
    clock.mockRestore();
  }
});

test("reopen retires only completed unchanged one-shots and preserves archived metadata", async () => {
  const state = await fixture();
  let { harness, main } = await state.open();
  const now = Date.now();
  const cases = [
    "completed",
    "failed",
    "aborted",
    "unexecuted",
    "recurring",
    "edited",
    "rearmed",
    "latest-failed",
    "active",
  ];
  for (const id of cases) {
    await state.orchestration.importJob({
      title: "Scheduled test task",
      id,
      workspaceId: "test",
      prompt: `original ${id}`,
      enabled: false,
      schedule:
        id === "recurring"
          ? { kind: "every", every: "1h", everyMs: 3600000 }
          : { kind: "at", at: new Date(now - 10000).toISOString() },
      createdAt: now - 20000,
      updatedAt: id === "edited" ? now : now - 20000,
      ...(id === "rearmed" ? { nextAt: now + 3600000 } : {}),
    });
    if (id === "unexecuted") continue;
    await main.commit(async (tx) => {
      const run = {
        id: `${id}:old`,
        jobId: id,
        workspaceId: "test",
        scheduledAt: now - 10000,
        startedAt: now - 9000,
        finishedAt: now - 8000,
        taskId: 1 as never,
        sessionId: String(main.id),
        status: (id === "failed" ? "failed" : id === "aborted" ? "aborted" : "completed") as
          | "completed"
          | "failed"
          | "aborted",
        output: "retained output",
      };
      if (id === "completed")
        await indexRun(tx, {
          ...run,
          id: `${id}:earlier-failure`,
          startedAt: now - 15000,
          finishedAt: now - 14000,
          status: "failed",
        });
      await indexRun(tx, run);
      if (id === "active") {
        const active: CronRun = { ...run, id: `${id}:running`, status: "running" };
        delete active.finishedAt;
        await indexRun(tx, active);
        (await tx.doc(OrchestrationDoc)).runs[active.id] = active;
      }
      if (id === "latest-failed")
        await indexRun(tx, {
          ...run,
          id: `${id}:new`,
          startedAt: now - 7000,
          finishedAt: now - 6000,
          status: "failed",
        });
    }, context);
  }
  await harness.close(context);
  ({ harness, main } = await state.open());
  expect((await state.orchestration.listJobs()).map((job) => job.id)).toEqual(cases.slice(1));
  expect((await state.orchestration.listRunLogs("active"))[1]?.job?.prompt).toBe("original active");
  const [run] = await state.orchestration.listRunLogs("completed");
  expect(run).toMatchObject({
    status: "completed",
    output: "retained output",
    job: { prompt: "original completed" },
  });
  await harness.close(context);
  await state.open();
  const retainedRuns = await state.orchestration.listRunLogs("completed");
  expect(retainedRuns).toHaveLength(2);
  expect(retainedRuns[1]).toMatchObject({
    status: "failed",
    output: "retained output",
    job: { prompt: "original completed" },
  });
});

test("a persisted cron admission survives reopen and reports exactly once to main", async () => {
  const fixtureState = await fixture();
  let { harness, main } = await fixtureState.open();
  const job = await fixtureState.orchestration.addJob({
    title: "Scheduled test task",
    workspaceId: "test",
    prompt: "worker task",
    schedule: { kind: "at", in: "1h" },
  });
  // Move its durable deadline into the past without invoking a process-local runner.
  await main.commit(async (tx) => {
    (await tx.doc(OrchestrationDoc)).jobs[job.id]!.nextAt = Date.now() - 1;
  }, context);
  await harness.close(context);
  fixtureState.faux.setResponses([
    fauxAssistantMessage([fauxText("durable result")]),
    fauxAssistantMessage([fauxText("report received")]),
  ]);
  ({ harness, main } = await fixtureState.open());
  await fixtureState.orchestration.tick();
  await until(
    async () => (await fixtureState.orchestration.listRunLogs())[0]?.status === "completed",
  );
  await main.waitForIdle(context);
  const reports = (await main.context(context)).entries.filter((entry) =>
    entry.model?.some(
      (message) =>
        message.role === "user" && JSON.stringify(message.content).includes("durable result"),
    ),
  );
  expect(reports).toHaveLength(1);
  expect(await fixtureState.orchestration.listRunLogs()).toHaveLength(1);
  const worker = (await fixtureState.orchestration.listRunLogs())[0]!;
  expect(
    await fixtureState.orchestration.metadata(Number(worker.sessionId) as never),
  ).toMatchObject({ workspaceId: "test", isCron: true, isSubagent: false });
}, 15000);

test("a worker's cron tool defaults to its originating workspace", async () => {
  const { faux, orchestration, open } = await fixture();
  const { main } = await open();
  faux.setResponses(
    Array.from({ length: 12 }, () => (request) => {
      const last = request.messages.findLast((message) => message.role !== "system")!;
      const text = JSON.stringify(last.content);
      if (last.role === "user" && text.includes("launch scheduler"))
        return fauxAssistantMessage(
          [
            fauxToolCall("subagent", {
              action: "run",
              workspaceId: "other",
              prompt: "schedule future worker task",
            }),
          ],
          { stopReason: "toolUse" },
        );
      if (last.role === "user" && text.includes("schedule future worker task"))
        return fauxAssistantMessage(
          [
            fauxToolCall("cron", {
              action: "add",
              title: "Scheduled test task",
              prompt: "future scheduled task",
              schedule: { kind: "at", in: "1h" },
            }),
          ],
          { stopReason: "toolUse" },
        );
      return fauxAssistantMessage([fauxText("done")]);
    }),
  );
  await (await main.submit({ type: "input", content: "launch scheduler" }, context)).wait(context);
  await until(async () => (await orchestration.listJobs()).length === 1);
  expect((await orchestration.listJobs())[0]!.workspaceId).toBe("other");
}, 15000);

test("imported cron preserves identity and interval phase across restart without admitting paused jobs", async () => {
  const { orchestration, open } = await fixture();
  let { harness } = await open();
  const job = {
    title: "Imported task",
    id: "legacy-job",
    workspaceId: "other",
    enabled: false,
    prompt: "legacy prompt",
    model: "faux/faux-2",
    thinkingLevel: "high",
    schedule: { kind: "every" as const, every: "5m", everyMs: 300000 },
    createdAt: 1000,
    updatedAt: 2000,
    nextAt: Date.now() - 1234,
  };
  expect(await orchestration.importJob(job)).toEqual(job);
  await expect(orchestration.importJob({ ...job, prompt: "overwrite" })).rejects.toThrow(
    "already exists",
  );
  await orchestration.tick();
  expect(await orchestration.listRunningCron()).toEqual([]);
  orchestration.close();
  await harness.close(context);
  ({ harness } = await open());
  expect(await orchestration.listJobs("other")).toEqual([job]);
  expect((await orchestration.updateJob(job.id, { enabled: true })).nextAt).toBe(job.nextAt);
});

test("cutover reconciles a legacy occurrence executed after the disabled import", async () => {
  const { orchestration, open } = await fixture();
  await open();
  const oldOccurrence = Date.now() - 1000;
  const imported = {
    title: "Cutover task",
    id: "cutover-job",
    workspaceId: "test",
    enabled: false,
    prompt: "legacy",
    schedule: { kind: "every" as const, every: "5m", everyMs: 300000 },
    createdAt: 1000,
    updatedAt: 2000,
    nextAt: oldOccurrence,
  };
  await orchestration.importJob(imported);
  // Batty1 executes oldOccurrence, then is disabled. Its final checkpoint advances one interval.
  const finalCheckpoint = oldOccurrence + 300000;
  await orchestration.removeJob(imported.id);
  await orchestration.importJob({ ...imported, nextAt: finalCheckpoint });
  await orchestration.updateJob(imported.id, { enabled: true });
  await orchestration.tick();
  expect(await orchestration.listRunLogs()).toEqual([]);
  expect((await orchestration.listJobs())[0]!.nextAt).toBe(finalCheckpoint);
});

test("cron import rejects invalid settings before persistence and accepts historical paused at jobs", async () => {
  const { orchestration, open } = await fixture();
  await open();
  const base = {
    title: "Historical task",
    id: "historical",
    workspaceId: "test",
    enabled: false,
    prompt: "done",
    schedule: { kind: "at" as const, at: "2020-01-01T00:00:00.000Z" },
    createdAt: 1000,
    updatedAt: 2000,
  };
  await expect(orchestration.importJob({ ...base, nextAt: NaN })).rejects.toThrow("timestamp");
  await expect(orchestration.importJob({ ...base, workspaceId: "missing" })).rejects.toThrow();
  await expect(orchestration.importJob({ ...base, thinkingLevel: "invalid" })).rejects.toThrow(
    "thinking",
  );
  await expect(
    orchestration.importJob({
      ...base,
      schedule: { kind: "cron", expression: "invalid", timezone: "UTC" },
    }),
  ).rejects.toThrow();
  expect(await orchestration.listJobs()).toEqual([]);
  expect(await orchestration.importJob(base)).toEqual(base);
});

test("cron isolates a bad job and its timer continues after the job is repaired", async () => {
  const errors: unknown[] = [];
  const { faux, orchestration, open } = await fixture(10000, (error) => {
    errors.push(error);
  });
  const { main } = await open();
  faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage([fauxText("done")])));
  const bad = await orchestration.addJob({
    title: "Scheduled test task",
    prompt: "bad workspace",
    schedule: { kind: "at", in: "1h" },
  });
  const good = await orchestration.addJob({
    title: "Scheduled test task",
    prompt: "good workspace",
    schedule: { kind: "at", in: "1h" },
  });
  await main.commit(async (tx) => {
    const jobs = (await tx.doc(OrchestrationDoc)).jobs;
    jobs[bad.id]!.workspaceId = "missing";
    jobs[bad.id]!.nextAt = Date.now() - 1;
    jobs[good.id]!.nextAt = Date.now() - 1;
  }, context);
  await orchestration.tick();
  await until(async () => (await orchestration.listRunLogs(good.id))[0]?.status === "completed");
  expect(errors).toHaveLength(1);
  expect((await orchestration.listJobs()).find((job) => job.id === bad.id)!.retryAt).toBeDefined();
  await orchestration.updateJob(bad.id, { workspaceId: "test" });
  // No explicit tick: the rearmed timer must admit the repaired job.
  await until(async () => (await orchestration.listRunLogs(bad.id))[0]?.status === "completed");
}, 15000);

test("fresh cron workers do not inherit the main transcript", async () => {
  const { faux, orchestration, open } = await fixture();
  const { harness, main } = await open();
  faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage([fauxText("done")])));
  const job = await orchestration.addJob({
    title: "Scheduled test task",
    prompt: "scheduled task prompt",
    schedule: { kind: "at", in: "1h" },
  });
  await main.commit(async (tx) => {
    (await tx.doc(OrchestrationDoc)).jobs[job.id]!.nextAt = Date.now() - 1;
    await tx.appendEntry(main.id, {
      kind: "pi.user",
      model: [{ role: "user", content: "private parent transcript", timestamp: 1 }],
    });
  }, context);
  await orchestration.tick();
  await until(async () => (await orchestration.listRunLogs(job.id))[0]?.status === "completed");
  const run = (await orchestration.listRunLogs(job.id))[0]!;
  const child = await orchestration.metadata(Number(run.sessionId) as never);
  expect(child?.isCron).toBe(true);
  const worker = (await harness.conversation(Number(run.sessionId) as never, context))!;
  const transcript = JSON.stringify((await worker.context(context)).messages);
  expect(transcript).toContain("scheduled task prompt");
  expect(transcript).not.toContain("private parent transcript");
}, 15000);
