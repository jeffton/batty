import { generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import type { AgentTurnFileChange, SentFileDescriptor, SiteDescriptor } from "@/shared/types";
import { BATTY_RUNTIME_NOTICE_CUSTOM_TYPE } from "./runtime-notices";

export const AGENT_TURN_FILE_CHANGES_CUSTOM_TYPE = "batty-agent-turn-file-changes";

/** Mutation snapshots live inside Pi's immutable tool results, not a second journal. */
export interface DurableFileChange extends AgentTurnFileChange {
  before: string | null;
  after: string;
}

export interface AgentTurnArtifacts {
  fileChanges?: AgentTurnFileChange[];
  sentFiles?: SentFileDescriptor[];
  sites?: SiteDescriptor[];
}

interface PersistedAgentTurnFileChanges {
  version: 1;
  replyEntryId: string;
  files: AgentTurnFileChange[];
}

interface ArtifactData {
  battyFileChanges?: DurableFileChange[];
  sentFiles?: SentFileDescriptor[];
  sites?: SiteDescriptor[];
}

function persistedFileChanges(value: unknown): PersistedAgentTurnFileChanges | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    typeof candidate.replyEntryId !== "string" ||
    !Array.isArray(candidate.files) ||
    !candidate.files.every(
      (file) => typeof file?.path === "string" && typeof file?.patch === "string",
    )
  )
    return undefined;
  return candidate as unknown as PersistedAgentTurnFileChanges;
}

function appendUniqueById<T extends { id: string }>(target: T[], values: T[]): void {
  const ids = new Set(target.map((value) => value.id));
  for (const value of values) {
    if (ids.has(value.id)) continue;
    ids.add(value.id);
    target.push(value);
  }
}

/**
 * Read-only UI projection, including historical Batty metadata imported by Pi.
 * A user entry starts a new aggregate only after a durable reply. Consumed steering
 * between tool batches belongs to the pending reply; retry responses retain its artifacts.
 */
export function agentTurnArtifactsByReplyEntryId(
  entries: Array<{
    type?: unknown;
    customType?: unknown;
    data?: unknown;
    id?: unknown;
    message?: unknown;
  }>,
): Map<string, AgentTurnArtifacts> {
  const result = new Map<string, AgentTurnArtifacts>();
  const changes = new Map<string, DurableFileChange>();
  const sentFiles: SentFileDescriptor[] = [];
  const sites: SiteDescriptor[] = [];
  let hasReply = false;

  const reset = () => {
    changes.clear();
    sentFiles.length = 0;
    sites.length = 0;
    hasReply = false;
  };

  for (const entry of entries) {
    if (entry.type === "message" && entry.message) {
      const message = entry.message as {
        role: string;
        customType?: string;
        content?: unknown;
        details?: { battyFileChanges?: DurableFileChange[] };
        data?: ArtifactData;
        battyDelivery?: { id: string; part: number };
        battyDeliveredFileChanges?: AgentTurnFileChange[];
      };

      // An async subagent completion starts or steers the parent reply that presents
      // its result, so seed that reply with every artifact collected from the child.
      const isAsyncSubagentResult =
        message.role === "custom" &&
        message.customType === `${BATTY_RUNTIME_NOTICE_CUSTOM_TYPE}:subagent` &&
        message.battyDelivery?.id.startsWith("subagent:");
      if (isAsyncSubagentResult) {
        if (hasReply) reset();
        for (const change of message.data?.battyFileChanges ?? []) {
          const first = changes.get(change.path);
          changes.set(change.path, { ...change, before: first ? first.before : change.before });
        }
        appendUniqueById(sentFiles, message.data?.sentFiles ?? []);
        appendUniqueById(sites, message.data?.sites ?? []);
        continue;
      }

      // Other delivered background results are not turns in this session. Their edits
      // belong to the child, and must not consume or inherit the parent's aggregate.
      if (message.battyDelivery) {
        if (
          message.role === "assistant" &&
          typeof entry.id === "string" &&
          message.battyDeliveredFileChanges
        ) {
          result.set(entry.id, { fileChanges: message.battyDeliveredFileChanges });
        }
        continue;
      }

      // Cron prompts start their own operation, including in copied daily context.
      // Delivery notices were skipped above and must not reset the parent's edits.
      const isCronPrompt =
        message.role === "custom" &&
        message.customType === `${BATTY_RUNTIME_NOTICE_CUSTOM_TYPE}:cron`;
      if (isCronPrompt || (message.role === "user" && hasReply)) reset();

      if (message.role === "assistant") {
        hasReply =
          Array.isArray(message.content) &&
          !message.content.some((block) => block.type === "toolCall");
      }
      if (message.role === "toolResult") {
        for (const change of message.details?.battyFileChanges ?? []) {
          const first = changes.get(change.path);
          changes.set(change.path, { ...change, before: first ? first.before : change.before });
        }
      }
      if (
        message.role === "assistant" &&
        typeof entry.id === "string" &&
        (changes.size || sentFiles.length || sites.length) &&
        Array.isArray(message.content) &&
        !message.content.some((block) => block.type === "toolCall")
      ) {
        result.set(entry.id, {
          ...(changes.size
            ? {
                fileChanges: [...changes.values()]
                  .filter((change) => change.before !== change.after)
                  .sort((left, right) => left.path.localeCompare(right.path))
                  .map((change) => ({
                    path: change.path,
                    patch: generateUnifiedPatch(change.path, change.before ?? "", change.after),
                  })),
              }
            : {}),
          ...(sentFiles.length ? { sentFiles: [...sentFiles] } : {}),
          ...(sites.length ? { sites: [...sites] } : {}),
        });
      }
    }

    if (entry.type === "custom" && entry.customType === AGENT_TURN_FILE_CHANGES_CUSTOM_TYPE) {
      const persisted = persistedFileChanges(entry.data);
      if (persisted) {
        result.set(persisted.replyEntryId, {
          ...result.get(persisted.replyEntryId),
          fileChanges: persisted.files,
        });
      }
    }
  }
  return result;
}

export function agentTurnFileChangesByReplyEntryId(
  entries: Parameters<typeof agentTurnArtifactsByReplyEntryId>[0],
): Map<string, AgentTurnFileChange[]> {
  return new Map(
    [...agentTurnArtifactsByReplyEntryId(entries)]
      .filter(([, artifacts]) => artifacts.fileChanges !== undefined)
      .map(([entryId, artifacts]) => [entryId, artifacts.fileChanges!]),
  );
}
