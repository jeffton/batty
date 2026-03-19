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
