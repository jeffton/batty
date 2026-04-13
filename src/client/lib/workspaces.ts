import type { WorkspaceInfo } from "@/shared/types";

export function uniqueWorkspaces(workspaces: WorkspaceInfo[]): WorkspaceInfo[] {
  const seenPaths = new Set<string>();

  return workspaces.filter((workspace) => {
    if (seenPaths.has(workspace.path)) {
      return false;
    }

    seenPaths.add(workspace.path);
    return true;
  });
}

export function sortWorkspacesByRecentSession(workspaces: WorkspaceInfo[]): WorkspaceInfo[] {
  return [...workspaces].sort((left, right) => {
    if (left.isPinned !== right.isPinned) {
      return left.isPinned ? -1 : 1;
    }

    return left.label.localeCompare(right.label, undefined, { sensitivity: "base" });
  });
}
