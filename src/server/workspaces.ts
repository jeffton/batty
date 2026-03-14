import fs from "node:fs/promises";
import path from "node:path";
import type { WorkspaceInfo } from "@/shared/types";
import type { AppConfig } from "./config";

function toWorkspaceId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function createHttpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function toWorkspaceInfo(workspacesRoot: string, name: string): WorkspaceInfo {
  return {
    id: toWorkspaceId(name),
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

  if (/[\\/]/.test(normalized)) {
    throw createHttpError(400, "Workspace name cannot contain path separators");
  }

  if (!toWorkspaceId(normalized)) {
    throw createHttpError(400, "Workspace name must include letters or numbers");
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

  const discovered = entries
    .filter((entry) => entry.isDirectory())
    .map<WorkspaceInfo>((entry) => toWorkspaceInfo(config.workspacesRoot, entry.name))
    .sort((a, b) => a.label.localeCompare(b.label));

  const selfWorkspace: WorkspaceInfo = {
    id: "pi-face",
    label: "pi-face",
    path: config.selfPath,
    kind: "self",
  };

  return [selfWorkspace, ...discovered.filter((workspace) => workspace.path !== config.selfPath)];
}

export async function createWorkspace(config: AppConfig, name: string): Promise<WorkspaceInfo> {
  const normalized = normalizeWorkspaceName(name);
  const workspacePath = resolveWorkspacePath(config.workspacesRoot, normalized);

  if (workspacePath === path.resolve(config.selfPath)) {
    throw createHttpError(409, "Workspace already exists: pi-face");
  }

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
