import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage, Usage } from "@mariozechner/pi-ai";

export const SUBAGENT_TOOL_NAME = "subagent";
export const SUBAGENT_EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export type SubagentEffort = (typeof SUBAGENT_EFFORT_LEVELS)[number];

export interface SubagentToolInput {
  prompt: string;
  model?: string;
  effort?: string;
  includeSessionContext?: boolean;
}

export interface SubagentToolDetails extends Record<string, unknown> {
  subagent: {
    prompt: string;
    model: string;
    effort: string;
    includeSessionContext: boolean;
    messageCount: number;
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

function isToolCallBlock(value: unknown): value is { type: "toolCall"; id: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "toolCall" &&
    typeof (value as { id?: unknown }).id === "string"
  );
}

export function cloneMessagesForSubagent(
  messages: AgentMessage[],
  currentToolCallId?: string,
): AgentMessage[] {
  const cloned = structuredClone(messages) as AgentMessage[];
  if (!currentToolCallId) {
    return cloned;
  }

  const lastMessage = cloned.at(-1);
  if (
    lastMessage?.role === "assistant" &&
    Array.isArray(lastMessage.content) &&
    lastMessage.content.some((block) => isToolCallBlock(block) && block.id === currentToolCallId)
  ) {
    cloned.pop();
  }

  return cloned;
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

export function buildSubagentDetails(
  input: Required<Pick<SubagentToolInput, "prompt">> & {
    model: string;
    effort: string;
    includeSessionContext: boolean;
  },
  messages: AgentMessage[],
  finalAssistant: AssistantMessage | undefined,
): SubagentToolDetails {
  return {
    subagent: {
      prompt: input.prompt,
      model: input.model,
      effort: input.effort,
      includeSessionContext: input.includeSessionContext,
      messageCount: messages.length,
      stopReason: finalAssistant?.stopReason,
      errorMessage: finalAssistant?.errorMessage,
    },
  };
}
