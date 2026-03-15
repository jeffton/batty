import type { UiMessage } from "@/shared/types";

export function withoutRenderedToolCalls(
  assistant: Extract<UiMessage, { role: "assistant" }> | undefined,
  renderedToolCallIds: Set<string>,
): Extract<UiMessage, { role: "assistant" }> | undefined {
  if (!assistant || renderedToolCallIds.size === 0) {
    return assistant;
  }

  const blocks = assistant.blocks.filter(
    (block) => block.type !== "toolCall" || !renderedToolCallIds.has(block.id),
  );

  if (blocks.length === assistant.blocks.length) {
    return assistant;
  }

  if (blocks.length === 0) {
    return undefined;
  }

  return {
    ...assistant,
    blocks,
  };
}
