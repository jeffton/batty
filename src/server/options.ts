import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export interface StoredAppOptions {
  authSecret?: string;
  workspacesRoot?: string;
  webPushSubject?: string;
  cronDailySessionStartTime?: string;
  braveSearchKey?: string;
  pinnedWorkspaceIds?: string[];
  assistantWorkspaceId?: string;
}

export interface AppOptions {
  authSecret: string;
  workspacesRoot: string;
  webPushSubject: string;
  cronDailySessionStartTime: string;
  braveSearchKey?: string;
  pinnedWorkspaceIds: string[];
  assistantWorkspaceId?: string;
}

const DEFAULT_CRON_DAILY_SESSION_START_TIME = "04:00";

const REQUIRED_OPTION_KEYS = ["workspacesRoot", "webPushSubject"] as const;

export function stateDirPath(battyDir: string): string {
  return path.join(battyDir, ".batty");
}

export function optionsFilePath(projectRoot: string): string {
  return path.join(stateDirPath(projectRoot), "options.json");
}

function createAuthSecret(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function normalizeDailySessionStartTime(value: unknown): string {
  if (value == null) {
    return DEFAULT_CRON_DAILY_SESSION_START_TIME;
  }
  if (typeof value !== "string") {
    throw new Error(
      `Invalid cronDailySessionStartTime in options.json: ${String(value)}. Expected HH:MM.`,
    );
  }

  const trimmed = value.trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (!match) {
    throw new Error(
      `Invalid cronDailySessionStartTime in options.json: ${trimmed}. Expected HH:MM.`,
    );
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
    throw new Error(
      `Invalid cronDailySessionStartTime in options.json: ${trimmed}. Expected HH:MM.`,
    );
  }

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function normalizeStoredOptions(options: StoredAppOptions | undefined): StoredAppOptions {
  return {
    authSecret:
      typeof options?.authSecret === "string" && options.authSecret.trim().length > 0
        ? options.authSecret.trim()
        : createAuthSecret(),
    workspacesRoot:
      typeof options?.workspacesRoot === "string" ? options.workspacesRoot.trim() : "",
    webPushSubject:
      typeof options?.webPushSubject === "string" ? options.webPushSubject.trim() : "",
    cronDailySessionStartTime: normalizeDailySessionStartTime(options?.cronDailySessionStartTime),
    braveSearchKey:
      typeof options?.braveSearchKey === "string" && options.braveSearchKey.trim().length > 0
        ? options.braveSearchKey.trim()
        : undefined,
    pinnedWorkspaceIds: Array.isArray(options?.pinnedWorkspaceIds)
      ? options.pinnedWorkspaceIds.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0,
        )
      : [],
    assistantWorkspaceId:
      typeof options?.assistantWorkspaceId === "string" &&
      options.assistantWorkspaceId.trim().length > 0
        ? options.assistantWorkspaceId.trim()
        : undefined,
  };
}

function missingRequiredOptions(options: StoredAppOptions): string[] {
  return REQUIRED_OPTION_KEYS.filter((key) => {
    const value = options[key];
    return typeof value !== "string" || value.length === 0;
  });
}

export async function readStoredOptions(
  projectRoot: string,
): Promise<StoredAppOptions | undefined> {
  try {
    const content = await fs.readFile(optionsFilePath(projectRoot), "utf8");
    return JSON.parse(content) as StoredAppOptions;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function writeStoredOptions(
  projectRoot: string,
  options: StoredAppOptions,
): Promise<void> {
  await fs.mkdir(stateDirPath(projectRoot), { recursive: true });
  await fs.writeFile(optionsFilePath(projectRoot), `${JSON.stringify(options, null, 2)}\n`, "utf8");
}

export async function loadAppOptions(projectRoot: string): Promise<AppOptions> {
  const stored = await readStoredOptions(projectRoot);
  const normalized = normalizeStoredOptions(stored);

  if (JSON.stringify(stored) !== JSON.stringify(normalized)) {
    await writeStoredOptions(projectRoot, normalized);
  }

  return normalized as AppOptions;
}

export async function ensureOptionsFile(projectRoot: string): Promise<AppOptions> {
  const normalized = await loadAppOptions(projectRoot);
  const missing = missingRequiredOptions(normalized);
  if (missing.length > 0) {
    throw new Error(
      `Missing required options in ${optionsFilePath(projectRoot)}: ${missing.join(", ")}.`,
    );
  }

  return normalized;
}

export async function setWorkspacePinned(
  projectRoot: string,
  workspaceId: string,
  pinned: boolean,
): Promise<AppOptions> {
  const options = await loadAppOptions(projectRoot);
  const nextPinnedWorkspaceIds = pinned
    ? [...new Set([...options.pinnedWorkspaceIds, workspaceId])]
    : options.pinnedWorkspaceIds.filter((id) => id !== workspaceId);

  const nextOptions: AppOptions = {
    ...options,
    pinnedWorkspaceIds: nextPinnedWorkspaceIds,
  };

  await writeStoredOptions(projectRoot, nextOptions);
  return nextOptions;
}

export async function setAssistantWorkspace(
  projectRoot: string,
  workspaceId: string | undefined,
): Promise<AppOptions> {
  const options = await loadAppOptions(projectRoot);
  const nextOptions: AppOptions = {
    ...options,
    assistantWorkspaceId: workspaceId,
  };

  await writeStoredOptions(projectRoot, nextOptions);
  return nextOptions;
}
