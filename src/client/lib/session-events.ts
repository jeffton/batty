import { applyImmutable } from "@earendil-works/chord/delta";
import { mergeHistory, mergeSessionSnapshot } from "@/client/lib/session-state";
import type { ServerEvent, SessionDocuments, SessionSnapshot } from "@/shared/types";

export function shouldUpdateSessionSummary(event: ServerEvent): boolean {
  return event.type !== "error";
}

export function shouldWriteSessionCache(
  event: ServerEvent,
  previous: SessionSnapshot,
  next: SessionSnapshot,
): boolean {
  if (event.type === "error") return false;
  if (event.type === "session") return true;
  if (event.messages || previous.historyVersion !== next.historyVersion) return true;
  if (Boolean(previous.documents["pi.live"].run) !== Boolean(next.documents["pi.live"].run))
    return true;
  // updatedAt tracks activity, including live partials; it is not a cache checkpoint.
  const { updatedAt: _previousUpdatedAt, ...previousMetadata } = previous.metadata;
  const { updatedAt: _nextUpdatedAt, ...nextMetadata } = next.metadata;
  return JSON.stringify(previousMetadata) !== JSON.stringify(nextMetadata);
}

export function applyServerEvent(
  snapshot: SessionSnapshot | undefined,
  event: ServerEvent,
): SessionSnapshot | undefined {
  if (event.type === "error") return snapshot;
  if (event.type === "session") return mergeSessionSnapshot(event.snapshot, snapshot);
  if (!snapshot) return undefined;
  const historyIsCurrent = event.historyVersion >= snapshot.historyVersion;
  return {
    metadata: event.metadata,
    documents: applyImmutable<SessionDocuments>(snapshot.documents, event.documents),
    queuedClientMessageIds: event.queuedClientMessageIds,
    messages:
      historyIsCurrent && event.messages
        ? mergeHistory(
            event.messages,
            snapshot.messages,
            event.metadata.messagesDetailLevel === "summary" &&
              event.metadata.totalMessageCount > 0,
          )
        : snapshot.messages,
    historyVersion: Math.max(snapshot.historyVersion, event.historyVersion),
  };
}
