import { Cron } from "croner";
import type { Schedule, ScheduleInput } from "./orchestration-state.js";

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
export function normalizeSchedule(input: ScheduleInput, now: number): Schedule {
  if (input.kind === "every") return { ...input, everyMs: parseDuration(input.every) };
  if (input.kind === "cron") {
    const schedule = { ...input, timezone: input.timezone ?? "UTC" };
    new Cron(schedule.expression, { timezone: schedule.timezone, paused: true }).stop();
    return schedule;
  }
  const at = input.in ? now + parseDuration(input.in) : Date.parse(input.at!);
  if (!Number.isFinite(at) || at <= now) throw new Error("At schedule must be in the future");
  return { kind: "at", at: new Date(at).toISOString() };
}
export function nextAt(schedule: Schedule, after: number): number | undefined {
  if (schedule.kind === "at")
    return Date.parse(schedule.at) > after ? Date.parse(schedule.at) : undefined;
  if (schedule.kind === "every") return after + schedule.everyMs;
  const cron = new Cron(schedule.expression, { timezone: schedule.timezone, paused: true });
  const result = cron.nextRun(new Date(after))?.getTime();
  cron.stop();
  return result;
}
