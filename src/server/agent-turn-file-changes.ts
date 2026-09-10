import { generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import type { AgentTurnFileChange } from "@/shared/types";
import { BATTY_RUNTIME_NOTICE_CUSTOM_TYPE } from "./runtime-notices";

export const AGENT_TURN_FILE_CHANGES_CUSTOM_TYPE = "batty-agent-turn-file-changes";

/** Mutation snapshots live inside Pi's immutable tool results, not a second journal. */
export interface DurableFileChange extends AgentTurnFileChange {
  before: string | null;
  after: string;
}
interface PersistedAgentTurnFileChanges {
  version: 1;
  replyEntryId: string;
  files: AgentTurnFileChange[];
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

/**
 * Read-only UI projection, including historical Batty metadata imported by Pi.
 * A user entry starts a new aggregate only after a durable reply. Consumed steering
 * between tool batches belongs to the pending reply; retry responses retain its edits.
 */
export function agentTurnFileChangesByReplyEntryId(
  entries: Array<{
    type?: unknown;
    customType?: unknown;
    data?: unknown;
    id?: unknown;
    message?: unknown;
  }>,
): Map<string, AgentTurnFileChange[]> {
  const result = new Map<string, AgentTurnFileChange[]>();
  const changes = new Map<string, DurableFileChange>();
  let hasReply = false;
  for (const entry of entries) {
    if (entry.type === "message" && entry.message) {
      const message = entry.message as {
        role: string;
        customType?: string;
        content?: unknown;
        details?: { battyFileChanges?: DurableFileChange[] };
        battyDelivery?: { id: string; part: number };
        battyDeliveredFileChanges?: AgentTurnFileChange[];
      };
      // Delivered background results are not turns in this session. Their edits
      // belong to the child, and must not consume or inherit the parent's aggregate.
      if (message.battyDelivery) {
        if (
          message.role === "assistant" &&
          typeof entry.id === "string" &&
          message.battyDeliveredFileChanges
        ) {
          result.set(entry.id, message.battyDeliveredFileChanges);
        }
        continue;
      }
      // Cron prompts start their own operation, including in copied daily context.
      // Delivery notices were skipped above and must not reset the parent's edits.
      const isCronPrompt =
        message.role === "custom" &&
        message.customType === `${BATTY_RUNTIME_NOTICE_CUSTOM_TYPE}:cron`;
      if (isCronPrompt || (message.role === "user" && hasReply)) {
        changes.clear();
        hasReply = false;
      }
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
        changes.size &&
        Array.isArray(message.content) &&
        !message.content.some((block) => block.type === "toolCall")
      ) {
        result.set(
          entry.id,
          [...changes.values()]
            .filter((change) => change.before !== change.after)
            .sort((left, right) => left.path.localeCompare(right.path))
            .map((change) => ({
              path: change.path,
              patch: generateUnifiedPatch(change.path, change.before ?? "", change.after),
            })),
        );
      }
    }
    if (entry.type === "custom" && entry.customType === AGENT_TURN_FILE_CHANGES_CUSTOM_TYPE) {
      const persisted = persistedFileChanges(entry.data);
      if (persisted) result.set(persisted.replyEntryId, persisted.files);
    }
  }
  return result;
}
