export interface WorkingHours {
  timeZone: string;
  /** ISO weekdays: Monday = 1, Sunday = 7. Overnight windows belong to their start day. */
  days: number[];
  start: string;
  end: string;
}

/** Validate options without silently disabling a malformed schedule. */
export function normalizeWorkingHours(value: unknown): WorkingHours | undefined {
  if (value === undefined) return undefined;
  const invalid = (reason: string): never => {
    throw new Error(`Invalid workingHours in options.json: ${reason}`);
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid("expected an object.");
  }
  const schedule = value as Record<string, unknown>;
  const keys = ["timeZone", "days", "start", "end"];
  if (Object.keys(schedule).some((key) => !keys.includes(key))) {
    return invalid("expected only timeZone, days, start and end.");
  }
  if (
    typeof schedule.timeZone !== "string" ||
    !(schedule.timeZone === "UTC" || /^[A-Za-z_]+\/[A-Za-z0-9_+\-/]+$/.test(schedule.timeZone))
  ) {
    return invalid("timeZone must be an explicit IANA name, such as Europe/Stockholm.");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: schedule.timeZone });
  } catch {
    return invalid("timeZone must be a valid IANA time zone.");
  }
  if (
    !Array.isArray(schedule.days) ||
    schedule.days.length === 0 ||
    schedule.days.some((day) => !Number.isInteger(day) || day < 1 || day > 7) ||
    new Set(schedule.days).size !== schedule.days.length
  ) {
    return invalid("days must contain unique ISO weekdays (1–7).");
  }
  const isTime = (time: unknown): time is string =>
    typeof time === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time);
  if (!isTime(schedule.start) || !isTime(schedule.end)) {
    return invalid("start and end must be HH:mm (00:00–23:59).");
  }
  if (schedule.start === schedule.end) return invalid("start and end must differ.");
  return {
    timeZone: schedule.timeZone,
    days: [...schedule.days],
    start: schedule.start,
    end: schedule.end,
  };
}

function localParts(schedule: WorkingHours, now: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: schedule.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    day: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(values.weekday!) + 1,
    time: `${values.hour}:${values.minute}`,
  };
}

export function isWithinWorkingHours(schedule: WorkingHours | undefined, now: Date): boolean {
  if (!schedule) return true;
  const local = localParts(schedule, now);
  if (schedule.start < schedule.end) {
    return (
      schedule.days.includes(local.day) && local.time >= schedule.start && local.time < schedule.end
    );
  }
  const previousDay = local.day === 1 ? 7 : local.day - 1;
  return (
    (schedule.days.includes(local.day) && local.time >= schedule.start) ||
    (schedule.days.includes(previousDay) && local.time < schedule.end)
  );
}

/** Calendar date in the configured zone, including during an overnight window. */
export function workingHoursDateKey(schedule: WorkingHours, now: Date): string {
  return localParts(schedule, now).date;
}
