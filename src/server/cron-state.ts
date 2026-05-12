import type { CronJobSession, CronJobState } from "@/shared/types";
import { createHttpError, normalizeNonEmptyString } from "./cron-http";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

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
    return { kind: "new" };
  }

  const session = value as { kind?: unknown; includePreviousContext?: unknown };
  switch (session.kind) {
    case "new":
      return { kind: "new" };
    case "daily-inline":
      return { kind: "daily-inline" };
    case "daily-detached":
    case "daily-subagent":
      return {
        kind: "daily-detached",
        includePreviousContext: session.includePreviousContext === true,
      };
    default:
      throw new Error(`Invalid cron session kind: ${String(session.kind)}`);
  }
}

export function migrateStoredSession(value: unknown): StoredCronJobSession {
  if (!value || typeof value !== "object") {
    return { kind: "new" };
  }

  const session = value as { kind?: unknown; includePreviousContext?: unknown };
  if (session.kind === "daily" || session.kind === "daily-subagent") {
    return {
      kind: "daily-detached",
      includePreviousContext: session.includePreviousContext === true,
    };
  }

  return normalizeStoredSession(value);
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
  const candidate = value && typeof value === "object" ? (value as Partial<CronJobState>) : {};
  return {
    nextRunAtMs:
      typeof candidate.nextRunAtMs === "number" && Number.isFinite(candidate.nextRunAtMs)
        ? candidate.nextRunAtMs
        : undefined,
    lastRunAtMs:
      typeof candidate.lastRunAtMs === "number" && Number.isFinite(candidate.lastRunAtMs)
        ? candidate.lastRunAtMs
        : undefined,
    lastDurationMs:
      typeof candidate.lastDurationMs === "number" && Number.isFinite(candidate.lastDurationMs)
        ? candidate.lastDurationMs
        : undefined,
    lastStatus:
      candidate.lastStatus === "ok" || candidate.lastStatus === "error"
        ? candidate.lastStatus
        : undefined,
    lastError:
      typeof candidate.lastError === "string" && candidate.lastError.length > 0
        ? candidate.lastError
        : undefined,
    lastSessionId:
      typeof candidate.lastSessionId === "string" && candidate.lastSessionId.length > 0
        ? candidate.lastSessionId
        : undefined,
    lastSessionPath:
      typeof candidate.lastSessionPath === "string" && candidate.lastSessionPath.length > 0
        ? candidate.lastSessionPath
        : undefined,
  };
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
