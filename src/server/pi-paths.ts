import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config";
import { stateDirPath } from "./options";

export interface BattyAgentSettings {
  theme?: string;
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
  sessionDir?: string;
  compaction?: Record<string, unknown>;
  [key: string]: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeSettingsValue(left: unknown, right: unknown): unknown {
  if (isPlainObject(left) && isPlainObject(right)) {
    const merged: Record<string, unknown> = { ...left };
    for (const [key, value] of Object.entries(right)) {
      merged[key] = key in merged ? mergeSettingsValue(merged[key], value) : value;
    }
    return merged;
  }

  return right;
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(content) as unknown;
    return isPlainObject(parsed) ? parsed : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function resolveResourcePath(value: string, baseDir: string): string {
  if (value.startsWith("~")) {
    return value;
  }
  if (path.isAbsolute(value)) {
    return value;
  }
  return path.resolve(baseDir, value);
}

function normalizeSettingsPaths(
  settings: Record<string, unknown> | undefined,
  baseDir: string,
): Partial<BattyAgentSettings> {
  if (!settings) {
    return {};
  }

  const normalized = { ...settings } as Record<string, unknown>;
  for (const key of ["extensions", "skills", "prompts", "themes"] as const) {
    const values = normalized[key];
    if (Array.isArray(values)) {
      normalized[key] = values
        .filter((value): value is string => typeof value === "string")
        .map((value) => resolveResourcePath(value, baseDir));
    }
  }

  if (typeof normalized.sessionDir === "string") {
    normalized.sessionDir = resolveResourcePath(normalized.sessionDir, baseDir);
  }

  return normalized as Partial<BattyAgentSettings>;
}

export function battyAgentDir(config: Pick<AppConfig, "battyDir">): string {
  return stateDirPath(config.battyDir);
}

export function workspaceBattyDir(workspacePath: string): string {
  return path.join(workspacePath, ".batty");
}

export function battySessionRootDir(config: Pick<AppConfig, "battyDir">): string {
  return path.join(stateDirPath(config.battyDir), "sessions");
}

export function workspaceSessionDir(
  config: Pick<AppConfig, "battyDir">,
  workspaceId: string,
): string {
  return path.join(battySessionRootDir(config), workspaceId);
}

export function workspaceCronSessionDir(
  config: Pick<AppConfig, "battyDir">,
  workspaceId: string,
  jobId: string,
  runId: string,
): string {
  return path.join(workspaceSessionDir(config, workspaceId), "cron", jobId, runId);
}

function getResourcePaths(
  settings: Partial<BattyAgentSettings>,
  key: "extensions" | "skills" | "prompts" | "themes",
): string[] {
  const value = settings[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

export function battyResourcePaths(
  config: Pick<AppConfig, "battyDir">,
  workspacePath: string,
  settings: Partial<BattyAgentSettings>,
): {
  extensions: string[];
  skills: string[];
  prompts: string[];
  themes: string[];
} {
  const agentDir = battyAgentDir(config);
  const projectDir = workspaceBattyDir(workspacePath);

  return {
    extensions: uniquePaths([
      ...getResourcePaths(settings, "extensions"),
      path.join(agentDir, "extensions"),
      path.join(projectDir, "extensions"),
    ]),
    skills: uniquePaths([
      ...getResourcePaths(settings, "skills"),
      path.join(agentDir, "skills"),
      path.join(projectDir, "skills"),
    ]),
    prompts: uniquePaths([
      ...getResourcePaths(settings, "prompts"),
      path.join(agentDir, "prompts"),
      path.join(projectDir, "prompts"),
    ]),
    themes: uniquePaths([
      ...getResourcePaths(settings, "themes"),
      path.join(agentDir, "themes"),
      path.join(projectDir, "themes"),
    ]),
  };
}

export async function loadBattySettings(
  config: Pick<AppConfig, "battyDir">,
  workspacePath: string,
): Promise<Partial<BattyAgentSettings>> {
  const globalDir = battyAgentDir(config);
  const projectDir = workspaceBattyDir(workspacePath);
  const globalSettings = normalizeSettingsPaths(
    await readJsonObject(path.join(globalDir, "settings.json")),
    globalDir,
  );
  const projectSettings = normalizeSettingsPaths(
    await readJsonObject(path.join(projectDir, "settings.json")),
    projectDir,
  );

  return mergeSettingsValue(globalSettings, projectSettings) as Partial<BattyAgentSettings>;
}

export async function loadBattyPromptFile(
  workspacePath: string,
  agentDir: string,
  fileName: "SYSTEM.md" | "APPEND_SYSTEM.md",
): Promise<string | undefined> {
  for (const filePath of [
    path.join(workspaceBattyDir(workspacePath), fileName),
    path.join(agentDir, fileName),
  ]) {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }

  return undefined;
}
