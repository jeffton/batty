import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
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
  password?: string;
  authSecret: string;
  workspacesRoot: string;
  webPushSubject: string;
}

export const DEFAULT_USERNAME = "pi-face";
export const DEFAULT_WEB_PUSH_SUBJECT = "https://pi.roybot.se";

export function stateDirPath(projectRoot: string): string {
  return path.join(projectRoot, ".pi-face");
}

export function legacyStateDirPath(projectRoot: string): string {
  return path.join(projectRoot, ".data");
}

export function optionsFilePath(projectRoot: string): string {
  return path.join(stateDirPath(projectRoot), "options.json");
}

function createAuthSecret(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function normalizeOptions(options: StoredAppOptions | undefined): AppOptions {
  return {
    username:
      typeof options?.username === "string" && options.username.trim().length > 0
        ? options.username.trim()
        : DEFAULT_USERNAME,
    password:
      typeof options?.password === "string" && options.password.length > 0
        ? options.password
        : undefined,
    authSecret:
      typeof options?.authSecret === "string" && options.authSecret.trim().length > 0
        ? options.authSecret
        : createAuthSecret(),
    workspacesRoot:
      typeof options?.workspacesRoot === "string" && options.workspacesRoot.trim().length > 0
        ? options.workspacesRoot
        : path.join(os.homedir(), "github"),
    webPushSubject:
      typeof options?.webPushSubject === "string" && options.webPushSubject.trim().length > 0
        ? options.webPushSubject.trim()
        : DEFAULT_WEB_PUSH_SUBJECT,
  };
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

async function writeStoredOptions(projectRoot: string, options: AppOptions): Promise<void> {
  await fs.mkdir(stateDirPath(projectRoot), { recursive: true });
  await fs.writeFile(optionsFilePath(projectRoot), `${JSON.stringify(options, null, 2)}\n`, "utf8");
}

export async function ensureOptionsFile(projectRoot: string): Promise<AppOptions> {
  const stored = await readStoredOptions(projectRoot);
  const normalized = normalizeOptions(stored);

  if (JSON.stringify(stored) !== JSON.stringify(normalized)) {
    await writeStoredOptions(projectRoot, normalized);
  }

  return normalized;
}

export async function migrateLegacyStateDirectory(projectRoot: string): Promise<void> {
  const legacyDir = legacyStateDirPath(projectRoot);
  const stateDir = stateDirPath(projectRoot);

  try {
    await fs.access(legacyDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  try {
    await fs.access(stateDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await fs.rename(legacyDir, stateDir);
      return;
    }
    throw error;
  }

  const entries = await fs.readdir(legacyDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(legacyDir, entry.name);
    const targetPath = path.join(stateDir, entry.name);
    await fs.cp(sourcePath, targetPath, { force: true, recursive: entry.isDirectory() });
  }

  await fs.rm(legacyDir, { recursive: true, force: true });
}
