import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppColor } from "@/shared/appearance";
import {
  DEFAULT_BROWSER_MAX_TABS,
  ensureOptionsFile,
  stateDirPath,
  type DefaultThinkingLevel,
} from "./options";

export interface AppConfig {
  host: string;
  port: number;
  workspacesRoots: string[];
  selfPath: string;
  battyDir: string;
  uploadsDir: string;
  sentFilesDir: string;
  sitesDir: string;
  publicDir: string;
  webPushDir: string;
  webPushSubject: string;
  cronDailySessionStartTime: string;
  braveSearchKey?: string;
  browserTailscaleSshDestination?: string;
  browserMaxTabs: number;
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: DefaultThinkingLevel;
  baseUrl: string;
  appTitle: string;
  appColor: AppColor;
  cookieName: string;
  authSecret: string;
}

export function resolveBattyDir(argv = process.argv.slice(2)): string {
  const battyDir = argv[0]?.trim();
  if (!battyDir) {
    throw new Error("Missing batty directory argument. Pass the deployment root path as argv[2].");
  }

  return path.resolve(battyDir);
}

export function environmentFilePath(battyDir: string): string {
  return path.join(stateDirPath(battyDir), "environment.json");
}

export async function readEnvironmentFile(battyDir: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await fs.readFile(environmentFilePath(battyDir), "utf8")) as Record<
      string,
      string
    >;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

const environmentWrites = new Map<string, Promise<void>>();

export function updateEnvironmentFile(
  battyDir: string,
  name: string,
  value?: string,
): Promise<string[]> {
  const previous = environmentWrites.get(battyDir) ?? Promise.resolve();
  const update = previous
    .catch(() => {})
    .then(async () => {
      const environment = await readEnvironmentFile(battyDir);
      if (value === undefined && !Object.hasOwn(environment, name)) {
        throw new Error("Environment variable not found");
      }
      const updated = Object.fromEntries(
        Object.entries(environment).filter(([key]) => key !== name),
      );
      if (value !== undefined) updated[name] = value;
      const filePath = environmentFilePath(battyDir);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporaryPath, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
        await fs.rename(temporaryPath, filePath);
      } finally {
        await fs.rm(temporaryPath, { force: true });
      }
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
      return Object.keys(updated).sort();
    });
  const settled = update.then(
    () => {},
    () => {},
  );
  environmentWrites.set(battyDir, settled);
  void settled.then(() => {
    if (environmentWrites.get(battyDir) === settled) environmentWrites.delete(battyDir);
  });
  return update;
}

export async function loadEnvironmentFile(battyDir: string): Promise<void> {
  for (const [key, value] of Object.entries(await readEnvironmentFile(battyDir))) {
    process.env[key] = value;
  }
}

export async function loadConfig(battyDir: string): Promise<AppConfig> {
  await loadEnvironmentFile(battyDir);

  const selfPath = process.env.BATTY_SELF_PATH?.trim() || process.cwd();
  const stateDir = stateDirPath(battyDir);
  const options = await ensureOptionsFile(battyDir);

  return {
    host: process.env.BATTY_HOST ?? "127.0.0.1",
    port: Number(process.env.BATTY_PORT ?? "3147"),
    workspacesRoots: options.workspacesRoots,
    selfPath,
    battyDir,
    uploadsDir: path.join(stateDir, "uploads"),
    sentFilesDir: path.join(stateDir, "sent-files"),
    sitesDir: path.join(stateDir, "sites"),
    publicDir: path.join(selfPath, "dist", "client"),
    webPushDir: path.join(stateDir, "web-push"),
    webPushSubject: options.webPushSubject,
    cronDailySessionStartTime: options.cronDailySessionStartTime,
    braveSearchKey: options.braveSearchKey,
    browserTailscaleSshDestination: options.browserTailscaleSshDestination,
    browserMaxTabs: options.browserMaxTabs ?? DEFAULT_BROWSER_MAX_TABS,
    defaultProvider: options.defaultProvider,
    defaultModel: options.defaultModel,
    defaultThinkingLevel: options.defaultThinkingLevel,
    baseUrl: options.baseUrl,
    appTitle: options.appTitle,
    appColor: options.appColor,
    cookieName: "batty-auth",
    authSecret: options.authSecret,
  };
}
