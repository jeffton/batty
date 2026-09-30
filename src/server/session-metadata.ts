import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const SESSION_TOOLS_CUSTOM_TYPE = "batty-session-tools";
export interface SessionTools {
  activeToolNames: string[];
}
export const SESSION_OPERATION_CUSTOM_TYPE = "batty-session-operation";
export interface SessionOperation {
  operationId: string;
  kind: "run" | "compaction" | "navigation";
  status: "completed" | "declined" | "failed" | "aborted";
  startEntryId: string | null;
  endEntryId: string | null;
  error?: { code: string; message: string };
  startedAt: number;
  endedAt: number;
}

/** End-inclusive, start-exclusive span on the referenced parent chain, not the selected branch. */
export function boundedSessionEntries(
  entries: SessionEntry[],
  startEntryId: string | null,
  endEntryId: string | null,
): SessionEntry[] {
  if (startEntryId === undefined || endEntryId === undefined)
    throw new Error("Result boundaries are required");
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  if (startEntryId !== null && !byId.has(startEntryId))
    throw new Error(`Missing result start entry ${startEntryId}`);
  if (endEntryId !== null && !byId.has(endEntryId))
    throw new Error(`Missing result end entry ${endEntryId}`);
  const result: SessionEntry[] = [];
  const visited = new Set<string>();
  let id = endEntryId;
  while (id !== startEntryId) {
    if (id === null) throw new Error("Result start is not an ancestor of its end");
    if (visited.has(id)) throw new Error("Cyclic result parent chain");
    visited.add(id);
    const entry = byId.get(id);
    if (!entry) throw new Error(`Missing result entry ${id}`);
    result.push(entry);
    id = entry.parentId;
  }
  return result.reverse();
}
