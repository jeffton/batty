import { hasMessageAttachments } from "@/client/lib/transcript";
import { chatOnlyBlocks } from "@/shared/chat-only-context";
import type { UiMessage } from "@/shared/types";

export function easyModeMessage(message: UiMessage): UiMessage | undefined {
  if (message.role === "user") {
    return chatOnlyBlocks(message.role, message.blocks) ? message : undefined;
  }
  if (message.role !== "assistant") return undefined;

  const blocks = chatOnlyBlocks(message.role, message.blocks);
  const next: Extract<UiMessage, { role: "assistant" }> = {
    ...message,
    blocks: blocks ?? [],
  };
  if (
    !blocks &&
    !hasMessageAttachments(next) &&
    !next.errorMessage &&
    next.stopReason !== "error"
  ) {
    return undefined;
  }

  return next;
}
