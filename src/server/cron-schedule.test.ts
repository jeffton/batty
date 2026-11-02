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

test("a fixed-time cron in a spring DST gap runs at the first valid local time", () => {
  const before = Date.parse("2026-03-28T23:00:00Z");
  const schedule = normalizeSchedule(
    { kind: "cron", expression: "30 2 * * *", timezone: "Europe/Stockholm" },
    before,
  );
  // Stockholm skips 02:00–02:59; 02:30 runs at 03:00, not 03:30.
  const gapRun = Date.parse("2026-03-29T01:00:00Z");
  expect(nextAt(schedule, before)).toBe(gapRun);
  expect(advanceSchedule(schedule, gapRun, gapRun)).toBe(Date.parse("2026-03-30T00:30:00Z"));
});

test("an interval cron advances through both occurrences of the fall DST hour", () => {
  const before = Date.parse("2026-10-25T00:00:00Z");
  const schedule = normalizeSchedule(
    { kind: "cron", expression: "*/30 * * * *", timezone: "Europe/Stockholm" },
    before,
  );
  // Local times are 02:30 CEST, 02:00 CET, 02:30 CET, then 03:00 CET.
  const runs = [
    "2026-10-25T00:30:00Z",
    "2026-10-25T01:00:00Z",
    "2026-10-25T01:30:00Z",
    "2026-10-25T02:00:00Z",
  ].map((value) => Date.parse(value));
  expect(nextAt(schedule, before)).toBe(runs[0]);
  for (let index = 0; index < runs.length - 1; index++) {
    const run = runs[index]!;
    expect(advanceSchedule(schedule, run, run)).toBe(runs[index + 1]);
  }
});

test("a fixed-time cron runs only at the first occurrence of a repeated fall DST time", () => {
  const before = Date.parse("2026-10-25T00:00:00Z");
  const schedule = normalizeSchedule(
    { kind: "cron", expression: "30 2 * * *", timezone: "Europe/Stockholm" },
    before,
  );
  const firstOccurrence = Date.parse("2026-10-25T00:30:00Z");
  const followingDay = Date.parse("2026-10-26T01:30:00Z");
  expect(nextAt(schedule, before)).toBe(firstOccurrence);
  expect(advanceSchedule(schedule, firstOccurrence, firstOccurrence)).toBe(followingDay);
  expect(nextAt(schedule, Date.parse("2026-10-25T01:00:00Z"))).toBe(followingDay);
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
