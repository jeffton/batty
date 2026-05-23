export const CRON_SESSION_CUSTOM_TYPE = "batty-cron-session";
export const CRON_RUN_SESSION_CUSTOM_TYPE = "batty-cron-run-session";

export interface DailyCronSessionBinding {
  version: 1;
  kind: "daily";
  date: string;
}

export interface CronRunSessionBinding {
  version: 1;
  kind: "run";
  jobId: string;
  runId: string;
  parentSessionId?: string;
}

export function buildDailyCronSessionBinding(
  now = new Date(),
  startTime = "04:00",
): DailyCronSessionBinding {
  return {
    version: 1,
    kind: "daily",
    date: toLocalIsoDate(now, startTime),
  };
}

export function findLatestDailyCronSessionBinding(
  entries: Array<{ type: string; customType?: string; data?: unknown }>,
): DailyCronSessionBinding | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== CRON_SESSION_CUSTOM_TYPE) {
      continue;
    }
    if (isDailyCronSessionBinding(entry.data)) {
      return entry.data;
    }
  }

  return undefined;
}

export function findDailyCronSessionBinding(
  entries: Array<{ type: string; customType?: string; data?: unknown }>,
  date = toLocalIsoDate(new Date(), "04:00"),
): DailyCronSessionBinding | undefined {
  const binding = findLatestDailyCronSessionBinding(entries);
  return binding?.date === date ? binding : undefined;
}

export function buildCronRunSessionBinding(input: {
  jobId: string;
  runId: string;
  parentSessionId?: string;
}): CronRunSessionBinding {
  return {
    version: 1,
    kind: "run",
    jobId: input.jobId,
    runId: input.runId,
    ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
  };
}

export function isCronRunSessionEntry(entry: {
  type?: unknown;
  customType?: unknown;
  data?: unknown;
}): boolean {
  return entry.type === "custom" && entry.customType === CRON_RUN_SESSION_CUSTOM_TYPE;
}

export function isParentedCronRunSessionEntry(entry: {
  type?: unknown;
  customType?: unknown;
  data?: unknown;
}): boolean {
  if (!isCronRunSessionEntry(entry) || !isCronRunSessionBinding(entry.data)) {
    return false;
  }

  return typeof entry.data.parentSessionId === "string" && entry.data.parentSessionId.length > 0;
}

export function hasCronRunSessionMarker(
  entries: Array<{ type?: unknown; customType?: unknown; data?: unknown }>,
): boolean {
  return entries.some(isCronRunSessionEntry);
}

export function hasParentedCronRunSessionMarker(
  entries: Array<{ type?: unknown; customType?: unknown; data?: unknown }>,
): boolean {
  return entries.some(isParentedCronRunSessionEntry);
}

export function localDayStartMs(now = new Date(), startTime = "04:00"): number {
  const startMinutes = parseDailySessionStartTime(startTime);
  const shifted = new Date(now.getTime() - startMinutes * 60 * 1000);
  const shiftedStart = new Date(shifted.getFullYear(), shifted.getMonth(), shifted.getDate());
  return shiftedStart.getTime() + startMinutes * 60 * 1000;
}

export function toLocalIsoDate(now = new Date(), startTime = "04:00"): string {
  const startMinutes = parseDailySessionStartTime(startTime);
  const shifted = new Date(now.getTime() - startMinutes * 60 * 1000);
  return formatIsoDate(shifted);
}

function parseDailySessionStartTime(startTime: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(startTime.trim());
  if (!match) {
    throw new Error(`Invalid daily session start time: ${startTime}`);
  }

  const hours = Number.parseInt(match[1] ?? "", 10);
  const minutes = Number.parseInt(match[2] ?? "", 10);
  if (
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    throw new Error(`Invalid daily session start time: ${startTime}`);
  }

  return hours * 60 + minutes;
}

function formatIsoDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function isDailyCronSessionBinding(value: unknown): value is DailyCronSessionBinding {
  if (!value || typeof value !== "object") {
    return false;
  }

  const binding = value as Partial<DailyCronSessionBinding>;
  return binding.version === 1 && binding.kind === "daily" && typeof binding.date === "string";
}

function isCronRunSessionBinding(value: unknown): value is CronRunSessionBinding {
  if (!value || typeof value !== "object") {
    return false;
  }

  const binding = value as Partial<CronRunSessionBinding>;
  return (
    binding.version === 1 &&
    binding.kind === "run" &&
    typeof binding.jobId === "string" &&
    typeof binding.runId === "string" &&
    (binding.parentSessionId === undefined || typeof binding.parentSessionId === "string")
  );
}
