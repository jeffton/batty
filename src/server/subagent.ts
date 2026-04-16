import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage, Usage } from "@mariozechner/pi-ai";
import type { SentFileDescriptor } from "@/shared/types";

export const SUBAGENT_TOOL_NAME = "subagent";
export const SUBAGENT_SESSION_CUSTOM_TYPE = "batty-subagent-session";
export const SUBAGENT_EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export type SubagentEffort = (typeof SUBAGENT_EFFORT_LEVELS)[number];

export interface SubagentToolInput {
  prompt: string;
  model?: string;
  effort?: string;
  includeSessionContext?: boolean;
}

export type SubagentRespondIn = "tool-call" | "session";

export interface SubagentToolDetails extends Record<string, unknown> {
  subagent: {
    prompt: string;
    model: string;
    effort: string;
    includeSessionContext: boolean;
    respondIn: SubagentRespondIn;
    messageCount: number;
    sessionId?: string;
    sessionPath?: string;
    stopReason?: string;
    errorMessage?: string;
  };
}

export const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

type AgentMessage = AgentSession["messages"][number];

function isToolCallBlock(value: unknown): value is { type: "toolCall"; id: string; name?: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "toolCall" &&
    typeof (value as { id?: unknown }).id === "string"
  );
}

function isSubagentToolCallMessage(message: AgentMessage | undefined): message is AgentMessage {
  return (
    message?.role === "assistant" &&
    Array.isArray(message.content) &&
    message.content.some(
      (block) =>
        isToolCallBlock(block) &&
        typeof block.name === "string" &&
        block.name === SUBAGENT_TOOL_NAME,
    )
  );
}

function isSubagentToolResultMessage(message: AgentMessage | undefined): boolean {
  return (
    message?.role === "toolResult" &&
    "toolName" in message &&
    message.toolName === SUBAGENT_TOOL_NAME
  );
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .flatMap((block) =>
      typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text"
        ? [String((block as { text?: unknown }).text ?? "")]
        : [],
    )
    .join("")
    .trim();
}

export function cloneMessagesForSubagent(
  messages: AgentMessage[],
  currentToolCallId?: string,
  injectedPrompt?: string,
): AgentMessage[] {
  const cloned = structuredClone(messages) as AgentMessage[];

  const lastMessage = cloned.at(-1);
  if (
    currentToolCallId &&
    lastMessage?.role === "assistant" &&
    Array.isArray(lastMessage.content) &&
    lastMessage.content.some((block) => isToolCallBlock(block) && block.id === currentToolCallId)
  ) {
    cloned.pop();
  }

  const trimmedPrompt = injectedPrompt?.trim();
  const trailingMessage = cloned.at(-1);
  if (
    trimmedPrompt &&
    trailingMessage?.role === "user" &&
    extractTextContent(trailingMessage.content) === trimmedPrompt
  ) {
    cloned.pop();
  }

  return cloned.filter(
    (message) => !isSubagentToolCallMessage(message) && !isSubagentToolResultMessage(message),
  );
}

export function extractAssistantText(
  message: { role: string; content?: unknown } | undefined,
): string {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) {
    return "";
  }

  return message.content
    .flatMap((block) =>
      typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text"
        ? [String((block as { text?: unknown }).text ?? "")]
        : [],
    )
    .join("")
    .trim();
}

export function findLastAssistantMessage(messages: AgentMessage[]): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") {
      return message as AssistantMessage;
    }
  }

  return undefined;
}

export function stripThinkingFromAssistantMessage(
  message: AssistantMessage | undefined,
): AssistantMessage | undefined {
  if (!message || !Array.isArray(message.content)) {
    return message;
  }

  return {
    ...message,
    content: message.content.filter(
      (block) => typeof block === "object" && block !== null && block.type !== "thinking",
    ) as AssistantMessage["content"],
  };
}

function isSentFileDescriptor(value: unknown): value is SentFileDescriptor {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { name?: unknown }).name === "string" &&
    typeof (value as { size?: unknown }).size === "number" &&
    typeof (value as { mimeType?: unknown }).mimeType === "string" &&
    typeof (value as { kind?: unknown }).kind === "string" &&
    typeof (value as { downloadUrl?: unknown }).downloadUrl === "string"
  );
}

export function collectSentFiles(messages: AgentMessage[]): SentFileDescriptor[] {
  const files: SentFileDescriptor[] = [];
  const seen = new Set<string>();

  for (const message of messages) {
    if (message.role !== "toolResult") {
      continue;
    }

    const details = (message as { details?: { sentFiles?: unknown } }).details;
    const sentFiles = details?.sentFiles;
    if (!Array.isArray(sentFiles)) {
      continue;
    }

    for (const file of sentFiles) {
      if (!isSentFileDescriptor(file) || seen.has(file.id)) {
        continue;
      }
      seen.add(file.id);
      files.push(file);
    }
  }

  return files;
}

export function newlyGeneratedSubagentMessages(
  messages: AgentMessage[],
  seedMessageCount: number,
): AgentMessage[] {
  return messages.slice(seedMessageCount);
}

export function buildSubagentDetails(
  input: Required<Pick<SubagentToolInput, "prompt">> & {
    model: string;
    effort: string;
    includeSessionContext: boolean;
    respondIn: SubagentRespondIn;
  },
  messages: AgentMessage[],
  finalAssistant: AssistantMessage | undefined,
  options?: { sentFileMessages?: AgentMessage[]; sessionId?: string; sessionPath?: string },
): SubagentToolDetails {
  const sentFiles = collectSentFiles(options?.sentFileMessages ?? messages);
  return {
    subagent: {
      prompt: input.prompt,
      model: input.model,
      effort: input.effort,
      includeSessionContext: input.includeSessionContext,
      respondIn: input.respondIn,
      messageCount: messages.length,
      ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options?.sessionPath ? { sessionPath: options.sessionPath } : {}),
      stopReason: finalAssistant?.stopReason,
      errorMessage: finalAssistant?.errorMessage,
    },
    ...(sentFiles.length > 0 ? { sentFiles } : {}),
  };
}

export function isSubagentSessionEntry(
  entry: { type?: unknown; customType?: unknown } | undefined,
): boolean {
  return entry?.type === "custom" && entry.customType === SUBAGENT_SESSION_CUSTOM_TYPE;
}

export function hasSubagentSessionMarker(
  entries: Array<{ type?: unknown; customType?: unknown }>,
): boolean {
  return entries.some((entry) => isSubagentSessionEntry(entry));
}
