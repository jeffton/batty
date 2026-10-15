export type ConversationRole = "assistant" | "worker" | "cron";

/** One permanent assistant owns OptChat; workers retain native compaction.
 * Workers in the configured assistant workspace may navigate its archive.
 */
export function conversationPolicy(
  role: ConversationRole,
  workspaceId?: string,
  assistantWorkspaceId?: string,
) {
  return {
    role,
    nativeCompaction: role !== "assistant",
    mainMemory:
      role === "assistant" ||
      (assistantWorkspaceId !== undefined && workspaceId === assistantWorkspaceId),
  };
}
