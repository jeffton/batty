import type { ActiveToolRun, UiMessage } from "@/shared/types";

export function withoutActiveToolCalls(
  assistant: Extract<UiMessage, { role: "assistant" }> | undefined,
  activeTools: ActiveToolRun[],
): Extract<UiMessage, { role: "assistant" }> | undefined {
  if (!assistant || activeTools.length === 0) {
    return assistant;
  }

  const activeToolIds = new Set(activeTools.map((tool) => tool.toolCallId));
  const blocks = assistant.blocks.filter(
    (block) => block.type !== "toolCall" || !activeToolIds.has(block.id),
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
