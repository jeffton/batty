import { NO_REPLY_SENTINEL } from "@/shared/agent-notification";
import type { UiMessage } from "@/shared/types";

function assistantText(message: Extract<UiMessage, { role: "assistant" }>): string {
  return message.blocks
    .map((block) =>
      block.type === "text" ? block.text : block.type === "thinking" ? block.thinking : "",
    )
    .join("")
    .trim();
}

export function easyModeMessage(message: UiMessage): UiMessage | undefined {
  if (
    message.role === "custom" ||
    message.role === "toolResult" ||
    message.role === "bashExecution"
  ) {
    return undefined;
  }

  if (message.role === "user") {
    return message;
  }

  const blocks = message.blocks.filter((block) => block.type === "text" || block.type === "image");
  const next: Extract<UiMessage, { role: "assistant" }> = { ...message, blocks };
  if (assistantText(next) === NO_REPLY_SENTINEL) {
    return undefined;
  }

  if (blocks.length === 0 && !next.errorMessage && next.stopReason !== "error") {
    return undefined;
  }

  return next;
}

export function easyModeMessages(messages: UiMessage[]): UiMessage[] {
  return messages.flatMap((message) => {
    const next = easyModeMessage(message);
    return next ? [next] : [];
  });
}
