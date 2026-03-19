import type { WorkspaceInfo } from "@/shared/types";

export function uniqueWorkspaces(workspaces: WorkspaceInfo[]): WorkspaceInfo[] {
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();

  return workspaces.filter((workspace) => {
    if (seenIds.has(workspace.id) || seenPaths.has(workspace.path)) {
      return false;
    }

    seenIds.add(workspace.id);
    seenPaths.add(workspace.path);
    return true;
  });
}
