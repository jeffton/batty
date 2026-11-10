import fs from "node:fs/promises";
import path from "node:path";
import type { WorkspaceFilesResponse } from "@/shared/workspace-files";
import { searchWorkspaceFileNames, withinWorkspace as within } from "../workspace-file-search";
import type { AppConfig } from "../config";
import { listWorkspaces } from "../workspaces";
import { workspaceGitBranch } from "../workspace-git";

function httpError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

async function workspaceFor(config: AppConfig, workspaceId: string) {
  const workspace = (await listWorkspaces(config)).find(
    (candidate) => candidate.id === workspaceId,
  );
  if (!workspace) throw httpError(404, "Workspace not found");
  return workspace;
}

export async function workspaceGit(config: AppConfig, workspaceId: string) {
  const workspace = await workspaceFor(config, workspaceId);
  return { branch: await workspaceGitBranch(workspace.path) };
}

export async function* workspaceSearch(
  config: AppConfig,
  workspaceId: string,
  name: string,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const workspace = await workspaceFor(config, workspaceId);
  if (!name) throw httpError(400, "File name is required");
  const root = await fs.realpath(workspace.path);
  yield* searchWorkspaceFileNames(root, name, signal);
}

export async function workspaceFiles(
  config: AppConfig,
  workspaceId: string,
  requested = "",
): Promise<WorkspaceFilesResponse> {
  const workspace = await workspaceFor(config, workspaceId);
  if (
    requested.includes("\0") ||
    requested.includes("\\") ||
    path.posix.isAbsolute(requested) ||
    path.win32.isAbsolute(requested) ||
    requested.split("/").includes("..")
  )
    throw httpError(400, "Path must stay inside the workspace");

  try {
    const root = await fs.realpath(workspace.path);
    const target = await fs.realpath(path.resolve(root, requested));
    if (!within(root, target)) throw httpError(403, "Path leaves the workspace");
    const stat = await fs.stat(target);
    if (stat.isDirectory()) {
      const children = await fs.readdir(target, { withFileTypes: true });
      const entries = await Promise.all(
        children.map(async (entry) => {
          let directory = entry.isDirectory();
          if (entry.isSymbolicLink()) {
            // Resolve only for classification; opening a link still checks containment.
            try {
              const link = await fs.realpath(path.join(target, entry.name));
              directory = within(root, link) && (await fs.stat(link)).isDirectory();
            } catch (cause) {
              if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
            }
          }
          return {
            path: path.posix.join(requested, entry.name),
            kind: directory ? ("directory" as const) : ("file" as const),
          };
        }),
      );
      entries.sort(
        (a, b) =>
          Number(b.kind === "directory") - Number(a.kind === "directory") ||
          a.path.localeCompare(b.path),
      );
      return { kind: "directory", path: requested, entries };
    }
    if (!stat.isFile()) return { kind: "unsupported", path: requested };
    const bytes = await fs.readFile(target);
    if (bytes.includes(0)) return { kind: "binary", path: requested };
    try {
      return {
        kind: "text",
        path: requested,
        contents: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      };
    } catch {
      return { kind: "binary", path: requested };
    }
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw httpError(404, "File not found");
    throw cause;
  }
}
