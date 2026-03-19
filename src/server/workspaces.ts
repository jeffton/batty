import fs from "node:fs/promises";
import path from "node:path";
import type { WorkspaceInfo } from "@/shared/types";
import type { AppConfig } from "./config";

function createHttpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function toWorkspaceInfo(workspacesRoot: string, name: string): WorkspaceInfo {
  return {
    id: name,
    label: name,
    path: path.join(workspacesRoot, name),
    kind: "workspace",
  };
}

function normalizeWorkspaceName(name: string): string {
  const normalized = name.trim();

  if (!normalized) {
    throw createHttpError(400, "Workspace name is required");
  }

  if (normalized === "." || normalized === "..") {
    throw createHttpError(400, "Workspace name must be a direct child folder");
  }

  if (normalized.startsWith(".")) {
    throw createHttpError(400, "Workspace name cannot start with a dot");
  }

  if (/[\\/]/.test(normalized)) {
    throw createHttpError(400, "Workspace name cannot contain path separators");
  }

  return normalized;
}

function resolveWorkspacePath(workspacesRoot: string, name: string): string {
  const resolvedRoot = path.resolve(workspacesRoot);
  const workspacePath = path.resolve(resolvedRoot, name);
  const relative = path.relative(resolvedRoot, workspacePath);

  if (
    !relative ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    relative.includes(path.sep)
  ) {
    throw createHttpError(400, "Workspace must be created directly under the workspaces root");
  }

  return workspacePath;
}

export async function listWorkspaces(config: AppConfig): Promise<WorkspaceInfo[]> {
  const entries = await fs.readdir(config.workspacesRoot, { withFileTypes: true }).catch(() => []);

  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map<WorkspaceInfo>((entry) => toWorkspaceInfo(config.workspacesRoot, entry.name))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export async function createWorkspace(config: AppConfig, name: string): Promise<WorkspaceInfo> {
  const normalized = normalizeWorkspaceName(name);
  const workspacePath = resolveWorkspacePath(config.workspacesRoot, normalized);

  await fs.mkdir(config.workspacesRoot, { recursive: true });

  try {
    await fs.mkdir(workspacePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "EEXIST") {
      throw createHttpError(409, `Workspace already exists: ${normalized}`);
    }
    throw error;
  }

  return toWorkspaceInfo(config.workspacesRoot, normalized);
}

export function resolveWorkspace(workspaces: WorkspaceInfo[], workspaceId: string): WorkspaceInfo {
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) {
    throw new Error(`Unknown workspace: ${workspaceId}`);
  }
  return workspace;
}
