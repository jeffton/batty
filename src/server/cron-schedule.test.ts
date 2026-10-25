import { expect, test } from "vite-plus/test";
import { advanceSchedule, nextAt, normalizeSchedule } from "./cron-schedule";
import { removeCompletedOneShot } from "./orchestration-lifecycle";
import type { CronJob, CronRun } from "./orchestration-state";

const start = Date.parse("2026-11-20T09:00:00Z");

test("overlapping overdue triggers coalesce without moving independent interval phases", () => {
  const schedule = normalizeSchedule(
    {
      kind: "multiple",
      triggers: [
        { kind: "at", in: "5m" },
        { kind: "at", in: "40m" },
        { kind: "every", every: "5m" },
        { kind: "every", every: "7m" },
        { kind: "cron", expression: "*/10 * * * *", timezone: "Europe/Stockholm" },
      ],
    },
    start,
  );
  expect(nextAt(schedule, start)).toBe(start + 5 * 60000);
  expect(advanceSchedule(schedule, start + 5 * 60000, start + 22 * 60000)).toBe(start + 25 * 60000);
  if (schedule.kind !== "multiple") throw new Error("Expected multiple schedule");
  expect(schedule.triggers.map((trigger) => trigger.nextAt)).toEqual([
    undefined,
    start + 40 * 60000,
    start + 25 * 60000,
    start + 28 * 60000,
    start + 30 * 60000,
  ]);
  // Only the five-minute trigger is due; the seven-minute one stays anchored at :28.
  expect(advanceSchedule(schedule, start + 25 * 60000, start + 25 * 60000)).toBe(
    start + 28 * 60000,
  );
  expect(schedule.triggers[3]!.nextAt).toBe(start + 28 * 60000);
});

test("an exhausted finite cron trigger roundtrips beside an active interval", () => {
  const before = Date.parse("2026-12-31T23:59:00Z");
  const after = Date.parse("2027-01-01T00:01:00Z");
  const schedule = normalizeSchedule(
    {
      kind: "multiple",
      triggers: [
        { kind: "cron", expression: "0 0 0 1 1 * 2027", timezone: "UTC" },
        { kind: "every", every: "1h" },
      ],
    },
    before,
  );
  advanceSchedule(schedule, Date.parse("2027-01-01T00:00:00Z"), after);
  if (schedule.kind !== "multiple") throw new Error("Expected multiple schedule");
  expect(schedule.triggers[0]).not.toHaveProperty("nextAt");
  expect(nextAt(schedule, after)).toBe(before + 3600000);
  expect(normalizeSchedule(JSON.parse(JSON.stringify(schedule)), after, true)).toEqual(schedule);
  expect(() =>
    normalizeSchedule(
      {
        kind: "multiple",
        triggers: [{ kind: "every", every: "1h" }],
      },
      after,
      true,
    ),
  ).toThrow("requires nextAt");
});

test("all one-shot triggers exhaust only after the last deadline", () => {
  const schedule = normalizeSchedule(
    {
      kind: "multiple",
      triggers: [
        { kind: "at", in: "5m" },
        { kind: "at", in: "10m" },
      ],
    },
    start,
  );
  expect(advanceSchedule(schedule, start + 5 * 60000, start + 5 * 60000)).toBe(start + 10 * 60000);
  expect(advanceSchedule(schedule, start + 10 * 60000, start + 10 * 60000)).toBeUndefined();
  expect(nextAt(schedule, start + 20 * 60000)).toBeUndefined();
});

test("multi-trigger validation rejects empty, nested and invalid triggers", () => {
  expect(() => normalizeSchedule({ kind: "multiple", triggers: [] }, start)).toThrow(
    "at least one",
  );
  expect(() =>
    normalizeSchedule({ kind: "multiple", triggers: [{ kind: "multiple" } as never] }, start),
  ).toThrow("Triggers must");
  expect(() =>
    normalizeSchedule({ kind: "multiple", triggers: [{ kind: "at", at: "2020-01-01" }] }, start),
  ).toThrow("future");
  expect(() =>
    normalizeSchedule(
      { kind: "multiple", triggers: [{ kind: "cron", expression: "invalid" }] },
      start,
    ),
  ).toThrow();
});

test("an earlier successful run cannot retire the final running or failed one-shot", () => {
  const schedule = normalizeSchedule(
    {
      kind: "multiple",
      triggers: [
        { kind: "at", in: "5m" },
        { kind: "at", in: "10m" },
      ],
    },
    start,
  );
  advanceSchedule(schedule, start + 5 * 60000, start + 10 * 60000);
  const job: CronJob = {
    id: "job",
    title: "Checks",
    workspaceId: "test",
    prompt: "Check",
    schedule,
    enabled: false,
    createdAt: start,
    updatedAt: start,
  };
  const jobs = { job };
  const run: CronRun = {
    id: "first",
    jobId: "job",
    workspaceId: "test",
    scheduledAt: start + 5 * 60000,
    startedAt: start + 5 * 60000,
    finishedAt: start + 11 * 60000,
    taskId: "task" as never,
    sessionId: "session",
    status: "completed",
  };
  removeCompletedOneShot(jobs, run);
  expect(jobs.job).toBe(job);
  removeCompletedOneShot(jobs, { ...run, startedAt: start + 10 * 60000, status: "failed" });
  expect(jobs.job).toBe(job);
  removeCompletedOneShot(jobs, { ...run, startedAt: start + 10 * 60000 });
  expect(jobs).toEqual({});
});
