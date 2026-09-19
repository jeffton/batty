import type { AgentMessage, Entry } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { chatOnlyBlocks } from "@/shared/chat-only-context";

export function filterMessagesForChatOnlyContext(messages: AgentMessage[]): Message[] {
  return messages.flatMap((message) => {
    if (message.role === "user") return [structuredClone(message) as Message];
    if (message.role !== "assistant") return [];

    const content = chatOnlyBlocks(message.role, message.content);
    return content ? [{ ...structuredClone(message), content } as Message] : [];
  });
}

export function chatOnlyMessagesFromBranch(entries: Entry[]): Message[] {
  return filterMessagesForChatOnlyContext(
    entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : [])),
  );
}
