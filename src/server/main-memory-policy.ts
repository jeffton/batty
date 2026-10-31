import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";

// Old names classify archived results only; they are not exposed tool aliases.
export const MAIN_MEMORY_TOOLS = new Set([
  "memory_zoom",
  "memory_date",
  "memory_search",
  "memory_overview",
  "zoom",
  "date",
]);

export function isMainMemoryView(message: Message): boolean {
  if (message.role !== "user" || message.timestamp !== 0) return false;
  const content =
    typeof message.content === "string"
      ? message.content
      : message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
  if (
    content.startsWith("<main-memory-background>\n") &&
    content.endsWith("\n</main-memory-background>")
  )
    return true;
  return /^<chat>\n(?:\d+\+\d+\|[^\n]*(?:\n\d+\+\d+\|[^\n]*)*)?\n<\/chat>(?:\n<!-- batty-optchat:[^\n]+ -->)?$/.test(
    content,
  );
}

type CodemodeDetails = {
  calls?: { name: string }[];
  mainMemoryFreeContent?: ToolResultMessage["content"];
};

// Identify executed tools, not JavaScript helper names. Codemode marks the
// ordinary tool outputs it can safely retain even from a mixed memory batch.
export function withoutMainMemory(messages: readonly Message[]): Message[] {
  const hiddenCalls = new Set<string>();
  const isolatedResults = new Map<string, ToolResultMessage>();
  for (const message of messages) {
    if (message.role !== "toolResult") continue;
    if (MAIN_MEMORY_TOOLS.has(message.toolName)) hiddenCalls.add(message.toolCallId);
    if (message.toolName !== "codemode") continue;
    const details = message.details as CodemodeDetails | undefined;
    if (!details?.calls?.some((call) => MAIN_MEMORY_TOOLS.has(call.name))) continue;
    const content = details.mainMemoryFreeContent ?? [];
    if (content.length)
      isolatedResults.set(message.toolCallId, { ...message, content, details: undefined });
    else hiddenCalls.add(message.toolCallId);
  }
  return messages.flatMap<Message>((message) => {
    if (message.role === "system" || isMainMemoryView(message)) return [];
    if (message.role === "toolResult") {
      if (hiddenCalls.has(message.toolCallId)) return [];
      return [isolatedResults.get(message.toolCallId) ?? message];
    }
    if (message.role !== "assistant") return [message];
    const content = message.content.filter(
      (part) => part.type !== "toolCall" || !hiddenCalls.has(part.id),
    );
    return content.length ? [{ ...message, content }] : [];
  });
}
