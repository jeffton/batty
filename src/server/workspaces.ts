import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { WorkspaceInfo } from "@/shared/types";
import type { AppConfig } from "./config";
import { loadAppOptions } from "./options";

function createHttpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function workspaceRootPaths(config: AppConfig): string[] {
  return config.workspacesRoots;
}

function workspaceIdFor(rootPath: string, name: string, multipleRoots: boolean): string {
  if (!multipleRoots) {
    return name;
  }

  const rootHash = crypto
    .createHash("sha256")
    .update(path.resolve(rootPath))
    .digest("base64url")
    .slice(0, 10);
  return `${name}--${rootHash}`;
}

function toWorkspaceInfo(
  workspacesRoot: string,
  name: string,
  pinnedWorkspaceIds: ReadonlySet<string>,
  assistantWorkspaceId?: string,
  multipleRoots = false,
): WorkspaceInfo {
  const id = workspaceIdFor(workspacesRoot, name, multipleRoots);
  return {
    id,
    label: name,
    path: path.join(workspacesRoot, name),
    ...(multipleRoots ? { rootPath: workspacesRoot } : {}),
    kind: "workspace",
    isPinned: pinnedWorkspaceIds.has(id),
    isAssistant: assistantWorkspaceId === id,
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

function resolveConfiguredRoot(config: AppConfig, requestedRootPath?: string): string {
  const roots = workspaceRootPaths(config);
  const selectedRoot = requestedRootPath?.trim() || roots[0] || "";
  const resolvedSelectedRoot = path.resolve(selectedRoot);
  const root = roots.find((candidate) => path.resolve(candidate) === resolvedSelectedRoot);

  if (!root) {
    throw createHttpError(400, "Workspace root is not configured");
  }

  return root;
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

export function listWorkspaceRoots(config: AppConfig): string[] {
  return workspaceRootPaths(config);
}

export async function listWorkspaces(config: AppConfig): Promise<WorkspaceInfo[]> {
  const options = await loadAppOptions(config.battyDir);
  const pinnedWorkspaceIds = new Set(options.pinnedWorkspaceIds);
  const roots = workspaceRootPaths(config);
  const multipleRoots = roots.length > 1;
  const workspaceGroups = await Promise.all(
    roots.map(async (root) => {
      const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
      return entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map<WorkspaceInfo>((entry) =>
          toWorkspaceInfo(
            root,
            entry.name,
            pinnedWorkspaceIds,
            options.assistantWorkspaceId,
            multipleRoots,
          ),
        );
    }),
  );

  return workspaceGroups.flat().sort((left, right) => {
    if (left.isPinned !== right.isPinned) {
      return left.isPinned ? -1 : 1;
    }

    const labelComparison = left.label.localeCompare(right.label, undefined, {
      sensitivity: "base",
    });
    if (labelComparison !== 0) {
      return labelComparison;
    }

    return (left.rootPath ?? "").localeCompare(right.rootPath ?? "", undefined, {
      sensitivity: "base",
    });
  });
}

export async function createWorkspace(
  config: AppConfig,
  name: string,
  rootPath?: string,
): Promise<WorkspaceInfo> {
  const normalized = normalizeWorkspaceName(name);
  const workspacesRoot = resolveConfiguredRoot(config, rootPath);
  const workspacePath = resolveWorkspacePath(workspacesRoot, normalized);

  await fs.mkdir(workspacesRoot, { recursive: true });

  try {
    await fs.mkdir(workspacePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "EEXIST") {
      throw createHttpError(409, `Workspace already exists: ${normalized}`);
    }
    throw error;
  }

  return toWorkspaceInfo(
    workspacesRoot,
    normalized,
    new Set(),
    undefined,
    workspaceRootPaths(config).length > 1,
  );
}

export function resolveWorkspace(workspaces: WorkspaceInfo[], workspaceId: string): WorkspaceInfo {
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) {
    throw new Error(`Unknown workspace: ${workspaceId}`);
  }
  return workspace;
}
