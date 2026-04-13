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

export function sortWorkspacesByRecentSession(
  workspaces: WorkspaceInfo[],
  pinnedWorkspaceIds: Iterable<string> = [],
): WorkspaceInfo[] {
  const pinnedWorkspaceIdSet = new Set(pinnedWorkspaceIds);

  return [...workspaces].sort((left, right) => {
    const leftPinned = pinnedWorkspaceIdSet.has(left.id);
    const rightPinned = pinnedWorkspaceIdSet.has(right.id);

    if (leftPinned !== rightPinned) {
      return leftPinned ? -1 : 1;
    }

    return left.label.localeCompare(right.label, undefined, { sensitivity: "base" });
  });
}
