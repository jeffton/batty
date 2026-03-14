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

export async function listWorkspaces(config: AppConfig): Promise<WorkspaceInfo[]> {
  const entries = await fs.readdir(config.workspacesRoot, { withFileTypes: true }).catch(() => []);

  const discovered = entries
    .filter((entry) => entry.isDirectory())
    .map<WorkspaceInfo>((entry) => ({
      id: toWorkspaceId(entry.name),
      label: entry.name,
      path: path.join(config.workspacesRoot, entry.name),
      kind: "workspace",
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const selfWorkspace: WorkspaceInfo = {
    id: "pi-face",
    label: "pi-face",
    path: config.selfPath,
    kind: "self",
  };

  return [selfWorkspace, ...discovered.filter((workspace) => workspace.path !== config.selfPath)];
}

export function resolveWorkspace(workspaces: WorkspaceInfo[], workspaceId: string): WorkspaceInfo {
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) {
    throw new Error(`Unknown workspace: ${workspaceId}`);
  }
  return workspace;
}
