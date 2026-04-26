import { Cron } from "croner";
import type { CronJobSchedule, CronJobScheduleInput } from "@/shared/types";
import { createHttpError, normalizeNonEmptyString } from "./cron-http";

const DEFAULT_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export interface StoredCronJobEverySchedule {
  kind: "every";
  every: string;
  everyMs: number;
  anchorAtMs: number;
}

export interface StoredCronJobAtSchedule {
  kind: "at";
  at: string;
}

export interface StoredCronJobCronSchedule {
  kind: "cron";
  expression: string;
  timezone: string;
}

export type StoredCronJobSchedule =
  | StoredCronJobAtSchedule
  | StoredCronJobEverySchedule
  | StoredCronJobCronSchedule;

function isDurationString(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith("+") || normalized.startsWith("in ") || /\d/.test(normalized);
}

export function parseDurationMs(value: string): number {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^in\s+/, "")
    .replace(/^\+/, "");
  const matcher = /([0-9]+(?:\.[0-9]+)?)\s*(ms|s|m|h|d|w)/g;
  let total = 0;

  for (const match of normalized.matchAll(matcher)) {
    const amount = Number(match[1]);
    const unit = match[2];
    if (!Number.isFinite(amount) || amount <= 0) {
      throw createHttpError(400, `Invalid duration: ${value}`);
    }

    const multiplier =
      unit === "ms"
        ? 1
        : unit === "s"
          ? 1000
          : unit === "m"
            ? 60 * 1000
            : unit === "h"
              ? 60 * 60 * 1000
              : unit === "d"
                ? 24 * 60 * 60 * 1000
                : 7 * 24 * 60 * 60 * 1000;

    total += amount * multiplier;
  }

  const compact = normalized.replace(/\s+/g, "");
  const matched = [...compact.matchAll(/([0-9]+(?:\.[0-9]+)?)(ms|s|m|h|d|w)/g)]
    .map((match) => match[0])
    .join("");

  if (!matched || matched.length !== compact.length || !Number.isFinite(total) || total <= 0) {
    throw createHttpError(
      400,
      `Invalid duration: ${value}. Use values like 10m, 2h, 1d, or 1h30m.`,
    );
  }

  return Math.round(total);
}

export function normalizeAtInput(
  input: Extract<CronJobScheduleInput, { kind: "at" }>,
  now: number,
): string {
  const relative = input.in?.trim();
  if (relative) {
    return new Date(now + parseDurationMs(relative)).toISOString();
  }

  const rawAt = input.at?.trim();
  if (!rawAt) {
    throw createHttpError(
      400,
      'Schedule "at" requires either an "at" timestamp or an "in" duration.',
    );
  }

  if (isDurationString(rawAt) && /^(?:\+|in\s+)/i.test(rawAt)) {
    return new Date(now + parseDurationMs(rawAt)).toISOString();
  }

  const date = new Date(rawAt);
  if (!Number.isFinite(date.getTime())) {
    throw createHttpError(
      400,
      `Invalid at schedule: ${rawAt}. Use an ISO timestamp or an in duration like 10m.`,
    );
  }
  if (date.getTime() <= now) {
    throw createHttpError(400, `At schedule must be in the future: ${rawAt}`);
  }

  return date.toISOString();
}

export function normalizeSchedule(
  input: CronJobScheduleInput,
  now = Date.now(),
): StoredCronJobSchedule {
  switch (input.kind) {
    case "at":
      return {
        kind: "at",
        at: normalizeAtInput(input, now),
      };
    case "every": {
      const every = normalizeNonEmptyString(input.every, "Every schedule");
      return {
        kind: "every",
        every,
        everyMs: parseDurationMs(every),
        anchorAtMs: now,
      };
    }
    case "cron":
      return {
        kind: "cron",
        expression: normalizeNonEmptyString(input.expression, "Cron expression"),
        timezone: input.timezone?.trim() || DEFAULT_TIMEZONE,
      };
    default:
      throw createHttpError(400, "Invalid schedule kind");
  }
}

export function toPublicSchedule(schedule: StoredCronJobSchedule): CronJobSchedule {
  switch (schedule.kind) {
    case "at":
      return { kind: "at", at: schedule.at };
    case "every":
      return { kind: "every", every: schedule.every };
    case "cron":
      return {
        kind: "cron",
        expression: schedule.expression,
        timezone: schedule.timezone,
      };
  }
}

export function formatScheduleLabel(schedule: StoredCronJobSchedule): string {
  switch (schedule.kind) {
    case "at":
      return `At ${schedule.at}`;
    case "every":
      return `Every ${schedule.every}`;
    case "cron":
      return `Cron ${schedule.expression} · ${schedule.timezone}`;
  }
}

export function nextEveryRunAtMs(schedule: StoredCronJobEverySchedule, now = Date.now()): number {
  if (schedule.anchorAtMs > now) {
    return schedule.anchorAtMs;
  }

  const elapsed = Math.max(0, now - schedule.anchorAtMs);
  const intervalsElapsed = Math.floor(elapsed / schedule.everyMs);
  const candidate = schedule.anchorAtMs + (intervalsElapsed + 1) * schedule.everyMs;
  return candidate > now ? candidate : candidate + schedule.everyMs;
}

export function nextRunAtMs(schedule: StoredCronJobSchedule, now = Date.now()): number | undefined {
  switch (schedule.kind) {
    case "at": {
      const atMs = new Date(schedule.at).getTime();
      return atMs > now ? atMs : undefined;
    }
    case "every":
      return nextEveryRunAtMs(schedule, now);
    case "cron": {
      const next = new Cron(schedule.expression, {
        timezone: schedule.timezone,
        paused: true,
      }).nextRun();
      return next ? next.getTime() : undefined;
    }
  }
}

export function normalizeStoredSchedule(value: unknown): StoredCronJobSchedule {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid cron schedule");
  }

  const schedule = value as Partial<StoredCronJobSchedule>;
  if (schedule.kind === "at") {
    return {
      kind: "at",
      at: normalizeAtInput({ kind: "at", at: schedule.at }, 0),
    };
  }

  if (schedule.kind === "every") {
    const every = normalizeNonEmptyString(schedule.every, "Every schedule");
    const everyMs =
      typeof schedule.everyMs === "number" && Number.isFinite(schedule.everyMs)
        ? schedule.everyMs
        : parseDurationMs(every);
    const anchorAtMs =
      typeof schedule.anchorAtMs === "number" && Number.isFinite(schedule.anchorAtMs)
        ? schedule.anchorAtMs
        : Date.now();

    return {
      kind: "every",
      every,
      everyMs,
      anchorAtMs,
    };
  }

  if (schedule.kind === "cron") {
    const expression = normalizeNonEmptyString(schedule.expression, "Cron expression");
    const timezone = schedule.timezone?.trim() || DEFAULT_TIMEZONE;
    new Cron(expression, { timezone, paused: true });
    return {
      kind: "cron",
      expression,
      timezone,
    };
  }

  throw new Error("Invalid cron schedule kind");
}
