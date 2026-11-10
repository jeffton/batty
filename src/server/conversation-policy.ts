export type ConversationRole = "assistant" | "worker" | "cron";

/** One permanent assistant owns OptChat; workers retain native compaction. */
export function conversationPolicy(role: ConversationRole) {
  return {
    role,
    nativeCompaction: role !== "assistant",
  };
}
