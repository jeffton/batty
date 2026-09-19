import { isAttachmentOutputToolCall } from "@/client/lib/transcript";
import type { ToolDisplayState } from "@/client/lib/transcript";
import { chatOnlyBlocks } from "@/shared/chat-only-context";
import type { UiMessage } from "@/shared/types";

export function easyModeMessage(
  message: UiMessage,
  toolStatesByCallId: Map<string, ToolDisplayState> = new Map(),
): UiMessage | undefined {
  if (message.role === "user") {
    return chatOnlyBlocks(message.role, message.blocks) ? message : undefined;
  }
  if (message.role !== "assistant") return undefined;

  const blocks = chatOnlyBlocks(message.role, message.blocks, (block) =>
    isAttachmentOutputToolCall(block, toolStatesByCallId),
  );
  const next: Extract<UiMessage, { role: "assistant" }> = {
    ...message,
    blocks: blocks ?? [],
  };
  if (
    !blocks &&
    (next.fileChanges?.length ?? 0) === 0 &&
    !next.errorMessage &&
    next.stopReason !== "error"
  ) {
    return undefined;
  }

  return next;
}

export function easyModeMessages(
  messages: UiMessage[],
  toolStatesByCallId: Map<string, ToolDisplayState> = new Map(),
): UiMessage[] {
  return messages.flatMap((message) => {
    const next = easyModeMessage(message, toolStatesByCallId);
    return next ? [next] : [];
  });
}
