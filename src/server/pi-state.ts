import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type { SessionState, UiContentBlock, UiMessage } from "@/shared/types";
import { sanitizeTerminalBlocks, stripTerminalFormatting } from "./terminal-output";

interface AssistantLikeMessage {
  role: "assistant";
  content: unknown;
  timestamp: number;
  model?: string;
  provider?: string;
  stopReason?: string;
  errorMessage?: string;
}

interface ToolResultLikeMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: unknown;
  isError: boolean;
  timestamp: number;
}

interface BashExecutionLikeMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode?: number;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  timestamp: number;
}

interface CustomLikeMessage {
  role: "custom";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}

export function normalizeBlocks(content: unknown): UiContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  return content.flatMap<UiContentBlock>((block, index) => {
    if (!block || typeof block !== "object") {
      return [];
    }

    const candidate = block as Record<string, unknown>;
    switch (candidate.type) {
      case "text":
        return typeof candidate.text === "string" ? [{ type: "text", text: candidate.text }] : [];
      case "image":
        return typeof candidate.mimeType === "string" && typeof candidate.data === "string"
          ? [{ type: "image", mimeType: candidate.mimeType, data: candidate.data }]
          : [];
      case "thinking":
        return typeof candidate.thinking === "string"
          ? [{ type: "thinking", thinking: candidate.thinking }]
          : [];
      case "toolCall":
        return [
          {
            type: "toolCall",
            id: typeof candidate.id === "string" ? candidate.id : `tool-${index}`,
            name: typeof candidate.name === "string" ? candidate.name : "tool",
            arguments:
              candidate.arguments && typeof candidate.arguments === "object"
                ? (candidate.arguments as Record<string, unknown>)
                : {},
          },
        ];
      default:
        return [];
    }
  });
}

function messageId(prefix: string, timestamp: number, index: number): string {
  return `${prefix}-${timestamp}-${index}`;
}

export function normalizeMessage(message: AgentMessage, index: number): UiMessage | undefined {
  if (message.role === "user") {
    return {
      id: messageId("user", message.timestamp, index),
      role: "user",
      timestamp: message.timestamp,
      blocks: normalizeBlocks(message.content),
    };
  }

  if (message.role === "assistant") {
    const assistant = message as AssistantLikeMessage;
    return {
      id: messageId("assistant", assistant.timestamp, index),
      role: "assistant",
      timestamp: assistant.timestamp,
      blocks: normalizeBlocks(assistant.content),
      model: assistant.model,
      provider: assistant.provider,
      stopReason: assistant.stopReason,
      errorMessage: assistant.errorMessage,
    };
  }

  if (message.role === "toolResult") {
    const toolResult = message as ToolResultLikeMessage;
    const blocks = normalizeBlocks(toolResult.content);
    return {
      id: messageId("tool", toolResult.timestamp, index),
      role: "toolResult",
      timestamp: toolResult.timestamp,
      toolCallId: toolResult.toolCallId,
      toolName: toolResult.toolName,
      blocks: toolResult.toolName === "bash" ? sanitizeTerminalBlocks(blocks) : blocks,
      isError: toolResult.isError,
    };
  }

  if (message.role === "bashExecution") {
    const bashExecution = message as BashExecutionLikeMessage;
    return {
      id: messageId("bash", bashExecution.timestamp, index),
      role: "bashExecution",
      timestamp: bashExecution.timestamp,
      command: bashExecution.command,
      output: stripTerminalFormatting(bashExecution.output),
      exitCode: bashExecution.exitCode ?? null,
      cancelled: bashExecution.cancelled,
      truncated: bashExecution.truncated,
      fullOutputPath: bashExecution.fullOutputPath,
    };
  }

  if (message.role === "custom") {
    const custom = message as CustomLikeMessage;
    return {
      id: messageId("custom", custom.timestamp, index),
      role: "custom",
      timestamp: custom.timestamp,
      customType: custom.customType,
      text:
        typeof custom.content === "string"
          ? custom.content
          : normalizeBlocks(custom.content)
              .map((block) =>
                "text" in block ? block.text : block.type === "thinking" ? block.thinking : "",
              )
              .join("\n")
              .trim(),
    };
  }

  return undefined;
}

export function normalizeMessages(messages: AgentMessage[]): UiMessage[] {
  return messages.map(normalizeMessage).filter((message): message is UiMessage => Boolean(message));
}

export interface SessionStateInput {
  id: string;
  sessionId: string;
  workspaceId: string;
  cwd: string;
  path?: string;
  model?: string;
  modelLabel?: string;
  thinkingLevel: string;
  availableThinkingLevels: string[];
  isStreaming: boolean;
  pendingMessageCount: number;
  updatedAt: number;
  contextTokens: number | null;
  contextWindow: number | null;
  contextPercent: number | null;
  messages: AgentMessage[];
  activeAssistant?: AgentMessage;
  title?: string;
  activeTools: SessionState["activeTools"];
}

export function createSessionState(input: SessionStateInput): SessionState {
  const activeAssistant =
    input.activeAssistant && input.activeAssistant.role === "assistant"
      ? (normalizeMessage(input.activeAssistant, Number.MAX_SAFE_INTEGER) as
          | Extract<UiMessage, { role: "assistant" }>
          | undefined)
      : undefined;

  return {
    id: input.id,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    cwd: input.cwd,
    path: input.path,
    model: input.model,
    modelLabel: input.modelLabel,
    thinkingLevel: input.thinkingLevel,
    availableThinkingLevels: input.availableThinkingLevels,
    isStreaming: input.isStreaming,
    pendingMessageCount: input.pendingMessageCount,
    updatedAt: input.updatedAt,
    contextTokens: input.contextTokens,
    contextWindow: input.contextWindow,
    contextPercent: input.contextPercent,
    messages: normalizeMessages(input.messages),
    activeAssistant,
    activeTools: input.activeTools,
    title: input.title,
  };
}
