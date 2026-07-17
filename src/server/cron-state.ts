import type { CronJobSession, CronJobState } from "@/shared/types";
import { createHttpError, normalizeNonEmptyString } from "./cron-http";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export type StoredCronJobSession =
  | { kind: "new" }
  | { kind: "daily-inline" }
  | {
      kind: "daily-detached";
      includePreviousContext: boolean;
    };

export function normalizeThinkingLevel(value: string | undefined): string {
  const thinkingLevel = normalizeNonEmptyString(value, "Thinking level").toLowerCase();
  if (!THINKING_LEVELS.has(thinkingLevel)) {
    throw createHttpError(
      400,
      `Invalid thinking level: ${thinkingLevel}. Expected one of ${[...THINKING_LEVELS].join(", ")}.`,
    );
  }
  return thinkingLevel;
}

export function normalizeStoredThinkingLevel(value: unknown): string {
  if (typeof value !== "string" || !THINKING_LEVELS.has(value)) {
    throw new Error(`Invalid stored thinking level: ${String(value)}`);
  }
  return value;
}

export function normalizeSession(value: CronJobSession | undefined): StoredCronJobSession {
  if (!value) {
    return { kind: "new" };
  }

  switch (value.kind) {
    case "new":
      return { kind: "new" };
    case "daily-inline":
      return { kind: "daily-inline" };
    case "daily-detached":
      return {
        kind: "daily-detached",
        includePreviousContext: value.includePreviousContext === true,
      };
    default:
      throw createHttpError(
        400,
        `Invalid cron session kind: ${String((value as { kind?: unknown }).kind)}`,
      );
  }
}

export function normalizeStoredSession(value: unknown): StoredCronJobSession {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid cron session");
  }

  const session = value as { kind?: unknown; includePreviousContext?: unknown };
  switch (session.kind) {
    case "new":
      return { kind: "new" };
    case "daily-inline":
      return { kind: "daily-inline" };
    case "daily-detached":
      if (typeof session.includePreviousContext !== "boolean") {
        throw new Error("Invalid daily detached context setting");
      }
      return {
        kind: "daily-detached",
        includePreviousContext: session.includePreviousContext,
      };
    default:
      throw new Error(`Invalid cron session kind: ${String(session.kind)}`);
  }
}

export function toPublicSession(session: StoredCronJobSession): CronJobSession {
  switch (session.kind) {
    case "new":
      return { kind: "new" };
    case "daily-inline":
      return { kind: "daily-inline" };
    case "daily-detached":
      return {
        kind: "daily-detached",
        includePreviousContext: session.includePreviousContext,
      };
  }
}

export function formatSessionLabel(session: CronJobSession | StoredCronJobSession): string {
  switch (session.kind) {
    case "new":
      return "New per run";
    case "daily-inline":
      return "Daily inline";
    case "daily-detached":
      return session.includePreviousContext === true
        ? "Daily detached · with previous context"
        : "Daily detached · fresh context";
  }
}

export function normalizeState(value: unknown): CronJobState {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid cron job state");
  }

  const candidate = value as Partial<CronJobState>;
  for (const [key, field] of [
    ["nextRunAtMs", candidate.nextRunAtMs],
    ["lastRunAtMs", candidate.lastRunAtMs],
    ["lastDurationMs", candidate.lastDurationMs],
  ] as const) {
    if (field !== undefined && (typeof field !== "number" || !Number.isFinite(field))) {
      throw new Error(`Invalid cron job state field: ${key}`);
    }
  }
  if (
    candidate.lastStatus !== undefined &&
    candidate.lastStatus !== "ok" &&
    candidate.lastStatus !== "error"
  ) {
    throw new Error("Invalid cron job state field: lastStatus");
  }
  for (const [key, field] of [
    ["lastError", candidate.lastError],
    ["lastSessionId", candidate.lastSessionId],
    ["lastSessionPath", candidate.lastSessionPath],
  ] as const) {
    if (field !== undefined && (typeof field !== "string" || field.length === 0)) {
      throw new Error(`Invalid cron job state field: ${key}`);
    }
  }

  return candidate;
}

export function markJobRunSucceeded(
  current: CronJobState,
  startedAt: number,
  result: { sessionId: string; sessionPath: string },
): CronJobState {
  return {
    ...current,
    lastRunAtMs: startedAt,
    lastDurationMs: Date.now() - startedAt,
    lastStatus: "ok",
    lastError: undefined,
    lastSessionId: result.sessionId,
    lastSessionPath: result.sessionPath,
  };
}

export function markJobRunFailed(
  current: CronJobState,
  startedAt: number,
  error: unknown,
): CronJobState {
  return {
    ...current,
    lastRunAtMs: startedAt,
    lastDurationMs: Date.now() - startedAt,
    lastStatus: "error",
    lastError: error instanceof Error ? error.message : String(error),
  };
}
