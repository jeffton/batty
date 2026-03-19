import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export interface StoredAppOptions {
  username?: string;
  password?: string;
  authSecret?: string;
  workspacesRoot?: string;
  webPushSubject?: string;
}

export interface AppOptions {
  username: string;
  password: string;
  authSecret: string;
  workspacesRoot: string;
  webPushSubject: string;
}

const REQUIRED_OPTION_KEYS = ["username", "password", "workspacesRoot", "webPushSubject"] as const;

export function stateDirPath(battyDir: string): string {
  return path.join(battyDir, ".batty");
}

export function optionsFilePath(projectRoot: string): string {
  return path.join(stateDirPath(projectRoot), "options.json");
}

function createAuthSecret(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function normalizeStoredOptions(options: StoredAppOptions | undefined): StoredAppOptions {
  return {
    username: typeof options?.username === "string" ? options.username.trim() : "",
    password: typeof options?.password === "string" ? options.password : "",
    authSecret:
      typeof options?.authSecret === "string" && options.authSecret.trim().length > 0
        ? options.authSecret.trim()
        : createAuthSecret(),
    workspacesRoot:
      typeof options?.workspacesRoot === "string" ? options.workspacesRoot.trim() : "",
    webPushSubject:
      typeof options?.webPushSubject === "string" ? options.webPushSubject.trim() : "",
  };
}

function missingRequiredOptions(options: StoredAppOptions): string[] {
  return REQUIRED_OPTION_KEYS.filter((key) => {
    const value = options[key];
    return typeof value !== "string" || value.length === 0;
  });
}

async function readStoredOptions(projectRoot: string): Promise<StoredAppOptions | undefined> {
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

async function writeStoredOptions(projectRoot: string, options: StoredAppOptions): Promise<void> {
  await fs.mkdir(stateDirPath(projectRoot), { recursive: true });
  await fs.writeFile(optionsFilePath(projectRoot), `${JSON.stringify(options, null, 2)}\n`, "utf8");
}

export async function ensureOptionsFile(projectRoot: string): Promise<AppOptions> {
  const stored = await readStoredOptions(projectRoot);
  const normalized = normalizeStoredOptions(stored);

  if (JSON.stringify(stored) !== JSON.stringify(normalized)) {
    await writeStoredOptions(projectRoot, normalized);
  }

  const missing = missingRequiredOptions(normalized);
  if (missing.length > 0) {
    throw new Error(
      `Missing required options in ${optionsFilePath(projectRoot)}: ${missing.join(", ")}.`,
    );
  }

  return normalized as AppOptions;
}
