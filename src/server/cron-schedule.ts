import { Cron } from "croner";
import type { Schedule, ScheduleInput, SingleSchedule } from "./orchestration-state.js";

export function parseDuration(value: string): number {
  const compact = value.toLowerCase().replace(/\s/g, "");
  const matches = [...compact.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d|w)/g)];
  if (matches.map((m) => m[0]).join("") !== compact || !matches.length)
    throw new Error(`Invalid duration: ${value}`);
  const units: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60000,
    h: 3600000,
    d: 86400000,
    w: 604800000,
  };
  const ms = Math.round(matches.reduce((n, m) => n + Number(m[1]) * units[m[2]!]!, 0));
  if (!Number.isFinite(ms) || ms <= 0) throw new Error(`Invalid duration: ${value}`);
  return ms;
}
export function normalizeSchedule(input: ScheduleInput, now: number, importing = false): Schedule {
  if (input.kind === "multiple") {
    if (!Array.isArray(input.triggers) || !input.triggers.length)
      throw new Error("Multiple schedule requires at least one trigger");
    return {
      kind: "multiple",
      triggers: input.triggers.map((trigger) => {
        if (!["at", "every", "cron"].includes(trigger.kind))
          throw new Error("Triggers must be at, every or cron schedules");
        const schedule = normalizeSchedule(trigger, now, importing) as SingleSchedule;
        const deadline = importing
          ? (trigger as SingleSchedule & { nextAt?: number }).nextAt
          : nextAt(schedule, now);
        if (deadline !== undefined && !Number.isFinite(deadline))
          throw new Error("Invalid trigger timestamp");
        if (
          importing &&
          schedule.kind !== "at" &&
          deadline === undefined &&
          nextAt(schedule, now) !== undefined
        )
          throw new Error("Recurring trigger requires nextAt on import");
        return { ...schedule, ...(deadline !== undefined ? { nextAt: deadline } : {}) };
      }),
    };
  }
  if (!["at", "every", "cron"].includes(input.kind)) throw new Error("Invalid schedule kind");
  if (input.kind === "every") return { ...input, everyMs: parseDuration(input.every) };
  if (input.kind === "cron") {
    const schedule = { ...input, timezone: input.timezone ?? "UTC" };
    new Cron(schedule.expression, { timezone: schedule.timezone, paused: true }).stop();
    return schedule;
  }
  const at = input.in ? now + parseDuration(input.in) : Date.parse(input.at!);
  if (!Number.isFinite(at) || (!importing && at <= now))
    throw new Error("At schedule must be in the future");
  return { kind: "at", at: new Date(at).toISOString() };
}
export function advanceSchedule(schedule: Schedule, scheduledAt: number, now: number) {
  if (schedule.kind === "multiple") {
    for (const trigger of schedule.triggers) {
      if (trigger.nextAt === undefined || trigger.nextAt > now) continue;
      const next = advanceSchedule(trigger, trigger.nextAt, now);
      if (next === undefined) delete trigger.nextAt;
      else trigger.nextAt = next;
    }
    return nextAt(schedule, now);
  }
  if (schedule.kind === "at") return undefined;
  if (schedule.kind === "every")
    return (
      scheduledAt + (Math.floor((now - scheduledAt) / schedule.everyMs) + 1) * schedule.everyMs
    );
  return nextAt(schedule, now);
}

export function isOneShot(schedule: Schedule): boolean {
  return (
    schedule.kind === "at" ||
    (schedule.kind === "multiple" && schedule.triggers.every((trigger) => trigger.kind === "at"))
  );
}

export function nextAt(schedule: Schedule, after: number): number | undefined {
  if (schedule.kind === "multiple") {
    const deadlines = schedule.triggers.flatMap((trigger) =>
      trigger.nextAt === undefined ? [] : [trigger.nextAt],
    );
    return deadlines.length ? Math.min(...deadlines) : undefined;
  }
  if (schedule.kind === "at")
    return Date.parse(schedule.at) > after ? Date.parse(schedule.at) : undefined;
  if (schedule.kind === "every") return after + schedule.everyMs;
  const cron = new Cron(schedule.expression, { timezone: schedule.timezone, paused: true });
  const result = cron.nextRun(new Date(after))?.getTime();
  cron.stop();
  return result;
}
