import type { UiContentBlock, UiMessage } from "@/shared/types";

export interface TranscriptMessageView {
  message: UiMessage;
  toolResultsByCallId: Map<string, Extract<UiMessage, { role: "toolResult" }>>;
}

export function buildTranscriptMessages(messages: UiMessage[]): TranscriptMessageView[] {
  const toolResultsByCallId = new Map<string, Extract<UiMessage, { role: "toolResult" }>>();
  const referencedToolCallIds = new Set<string>();

  for (const message of messages) {
    if (message.role === "assistant") {
      for (const block of message.blocks) {
        if (block.type === "toolCall") {
          referencedToolCallIds.add(block.id);
        }
      }
      continue;
    }

    if (message.role === "toolResult") {
      toolResultsByCallId.set(message.toolCallId, message);
    }
  }

  return messages.flatMap((message) => {
    if (message.role === "toolResult" && referencedToolCallIds.has(message.toolCallId)) {
      return [];
    }

    if (message.role === "assistant") {
      const resultMap = new Map<string, Extract<UiMessage, { role: "toolResult" }>>();

      for (const block of message.blocks) {
        if (block.type !== "toolCall") {
          continue;
        }

        const result = toolResultsByCallId.get(block.id);
        if (result) {
          resultMap.set(block.id, result);
        }
      }

      return [{ message, toolResultsByCallId: resultMap }];
    }

    return [{ message, toolResultsByCallId: new Map() }];
  });
}

export function hasToolResultContent(
  blocks: UiContentBlock[],
  details?: { diff?: string } | undefined,
): boolean {
  return blocks.length > 0 || typeof details?.diff === "string";
}
