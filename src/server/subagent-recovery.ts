import { randomUUID } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { DetachedSubagentOptions } from "./pi-service-subagents";
import { SessionStore, type SessionRead } from "./session-store";

export const SUBAGENT_OPERATION_CUSTOM_TYPE = "batty-subagent-operation";
export const SUBAGENT_DELIVERY_CUSTOM_TYPE = "batty-subagent-delivery";
export const SUBAGENT_QUEUE_CUSTOM_TYPE = "batty-subagent-queue";
export interface QueuedSubagentOperation {
  operationId: string;
  options: SubagentOperation["options"];
}
export interface SubagentOperation {
  operationId: string;
  startEntryId: string | null;
  options: Omit<DetachedSubagentOptions, "signal" | "onReady" | "onDelivered" | "onUpdate">;
}

export function findSubagentOperation(entries: SessionEntry[], sessionId: string) {
  const marker = entries.findLastIndex(
    (entry) =>
      entry.type === "custom" &&
      entry.customType === "batty-subagent-session" &&
      (entry.data as { sessionId: string }).sessionId === sessionId,
  );
  if (marker < 0) return undefined;
  const entry = entries
    .slice(marker + 1)
    .findLast(
      (entry) => entry.type === "custom" && entry.customType === SUBAGENT_OPERATION_CUSTOM_TYPE,
    );
  return entry?.type === "custom" ? (entry.data as SubagentOperation) : undefined;
}

export async function persistSubagentOperation(
  manager: SessionStore,
  options: DetachedSubagentOptions,
): Promise<SubagentOperation> {
  if (options.operationId) {
    const existing = manager
      .getEntries()
      .find(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === SUBAGENT_OPERATION_CUSTOM_TYPE &&
          (entry.data as SubagentOperation).operationId === options.operationId,
      );
    if (existing?.type === "custom") return existing.data as SubagentOperation;
  }
  const {
    signal: _signal,
    onReady: _ready,
    onDelivered: _delivered,
    onUpdate: _update,
    ...definition
  } = options;
  const operationId = options.operationId ?? randomUUID();
  const operation = {
    operationId,
    startEntryId: manager.getLeafId(),
    options: {
      ...definition,
      operationId,
      sessionId: manager.getSessionId(),
      continueSession: false,
    },
  };
  await manager.appendCustomEntry(SUBAGENT_OPERATION_CUSTOM_TYPE, operation);
  return operation;
}

export async function persistQueuedSubagentOperation(
  manager: SessionStore,
  options: SubagentOperation["options"],
): Promise<QueuedSubagentOperation> {
  const operationId = randomUUID();
  const queued = { operationId, options: { ...options, operationId } };
  await manager.appendCustomEntry(SUBAGENT_QUEUE_CUSTOM_TYPE, queued);
  return queued;
}

/** Definition entries activate queued requests; unactivated requests remain FIFO. */
export function readQueuedSubagentOperations(snapshot: SessionRead): QueuedSubagentOperation[] {
  // Forks inherit source receipts; only requests owned by this child are recoverable here.
  const ownMarker = snapshot.entries.findIndex(
    (entry) =>
      entry.type === "custom" &&
      entry.customType === "batty-subagent-session" &&
      (entry.data as { sessionId: string }).sessionId === snapshot.metadata.id,
  );
  if (ownMarker < 0) return [];
  const entries = snapshot.entries.slice(ownMarker + 1);
  const activated = new Set(
    entries.flatMap((entry) =>
      entry.type === "custom" && entry.customType === SUBAGENT_OPERATION_CUSTOM_TYPE
        ? [(entry.data as SubagentOperation).operationId]
        : [],
    ),
  );
  return entries.flatMap((entry) => {
    if (entry.type !== "custom" || entry.customType !== SUBAGENT_QUEUE_CUSTOM_TYPE) return [];
    const queued = entry.data as QueuedSubagentOperation;
    return activated.has(queued.operationId) ? [] : [queued];
  });
}

/** Host operations outlive native engine work, including pending parent delivery. */
export function readSubagentRecovery(snapshot: SessionRead): SubagentOperation | undefined {
  const operation = findSubagentOperation(snapshot.entries, snapshot.metadata.id);
  if (!operation) return undefined;
  const delivered = snapshot.entries.some(
    (entry) =>
      entry.type === "custom" &&
      entry.customType === SUBAGENT_DELIVERY_CUSTOM_TYPE &&
      (entry.data as { operationId: string }).operationId === operation.operationId,
  );
  const completed = snapshot.entries.some(
    (entry) =>
      entry.type === "custom" &&
      entry.customType === "batty-subagent-completion" &&
      (entry.data as { startEntryId: string | null }).startEntryId === operation.startEntryId,
  );
  return !completed || (operation.options.respondIn === "session" && !delivered)
    ? operation
    : undefined;
}
