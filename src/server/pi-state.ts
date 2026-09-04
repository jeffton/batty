import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { isPiShellToolName } from "@/shared/pi-tools";
import type {
  AgentTurnFileChange,
  SentFileDescriptor,
  SessionState,
  ToolExecutionDetails,
  UiAssistantTurnPhase,
  UiContentBlock,
  UiMessage,
} from "@/shared/types";
import { sanitizeTerminalBlocks, stripTerminalFormatting } from "./terminal-output";
import { agentTurnFileChangesByReplyEntryId } from "./agent-turn-file-changes";

type AgentMessage = AgentSession["messages"][number];

export type UiImageResolver = (image: {
  mimeType: string;
  data: string;
}) => { url: string; name?: string } | undefined;

interface NormalizeOptions {
  imageResolver?: UiImageResolver;
  includeToolDetails?: boolean;
  includedToolCallIds?: ReadonlySet<string>;
}

interface AssistantLikeMessage {
  role: "assistant";
  content: unknown;
  timestamp: number;
  model?: string;
  provider?: string;
  stopReason?: string;
  errorMessage?: string;
  battyFileChanges?: AgentTurnFileChange[];
}

interface ToolResultLikeMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: unknown;
  details?: ToolExecutionDetails;
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

type CustomMessageData = Record<string, unknown>;

interface CustomLikeMessage {
  role: "custom";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
  data?: CustomMessageData;
}

function normalizeToolDetails(details: unknown): ToolExecutionDetails | undefined {
  return details && typeof details === "object" ? (details as ToolExecutionDetails) : undefined;
}

function normalizeCustomData(data: unknown): CustomMessageData | undefined {
  return data && typeof data === "object" && !Array.isArray(data)
    ? (data as CustomMessageData)
    : undefined;
}

const UPLOADED_FILE_REFERENCE_PATTERN =
  /<file name="([^"]*)" mimeType="([^"]*)" size="(\d+)" path="[^"]*" url="([^"]*)"><\/file>/g;

function decodeXmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function normalizeUserText(text: string): UiContentBlock[] {
  const matches = [...text.matchAll(UPLOADED_FILE_REFERENCE_PATTERN)];
  if (matches.length === 0) {
    return [{ type: "text", text }];
  }

  const blocks: UiContentBlock[] = [];
  let textStart = 0;

  for (const match of matches) {
    const matchIndex = match.index;
    const visibleText = text.slice(textStart, matchIndex).trim();
    if (visibleText) {
      blocks.push({ type: "text", text: visibleText });
    }

    const mimeType = decodeXmlAttribute(match[2] as string);
    if (!mimeType.startsWith("image/")) {
      const downloadUrl = decodeXmlAttribute(match[4] as string);
      const file: SentFileDescriptor = {
        id: downloadUrl,
        name: decodeXmlAttribute(match[1] as string),
        size: Number(match[3]),
        mimeType,
        kind: mimeType.startsWith("video/") ? "video" : "file",
        downloadUrl,
      };
      blocks.push({ type: "attachment", file });
    }

    textStart = matchIndex + match[0].length;
  }

  const trailingText = text.slice(textStart).trim();
  if (trailingText) {
    blocks.push({ type: "text", text: trailingText });
  }

  return blocks;
}

function normalizeUserBlocks(content: unknown, options: NormalizeOptions): UiContentBlock[] {
  return normalizeBlocks(content, options).flatMap((block) =>
    block.type === "text" ? normalizeUserText(block.text) : [block],
  );
}

function normalizeBattyAttachments(message: unknown): UiContentBlock[] {
  const attachments = (message as { battyAttachments?: unknown }).battyAttachments;
  if (!Array.isArray(attachments)) {
    return [];
  }

  return attachments.flatMap<UiContentBlock>((attachment) => {
    if (!attachment || typeof attachment !== "object") {
      return [];
    }

    const candidate = attachment as Record<string, unknown>;
    return candidate.kind === "image" &&
      typeof candidate.mimeType === "string" &&
      typeof candidate.url === "string"
      ? [
          {
            type: "image",
            mimeType: candidate.mimeType,
            url: candidate.url,
            name: typeof candidate.name === "string" ? candidate.name : undefined,
          },
        ]
      : [];
  });
}

export function normalizeBlocks(
  content: unknown,
  options: NormalizeOptions = {},
): UiContentBlock[] {
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
      case "image": {
        if (
          typeof candidate.mimeType !== "string" ||
          (typeof candidate.data !== "string" && typeof candidate.url !== "string")
        ) {
          return [];
        }

        const resolved =
          typeof candidate.data === "string"
            ? options.imageResolver?.({ mimeType: candidate.mimeType, data: candidate.data })
            : undefined;
        return [
          {
            type: "image",
            mimeType: candidate.mimeType,
            data:
              !resolved && typeof candidate.url !== "string" && typeof candidate.data === "string"
                ? candidate.data
                : undefined,
            url: resolved?.url ?? (typeof candidate.url === "string" ? candidate.url : undefined),
            name:
              resolved?.name ?? (typeof candidate.name === "string" ? candidate.name : undefined),
          },
        ];
      }
      case "thinking":
        return typeof candidate.thinking === "string"
          ? [{ type: "thinking", thinking: candidate.thinking }]
          : [];
      case "toolCall":
        return options.includeToolDetails === false &&
          !options.includedToolCallIds?.has(
            typeof candidate.id === "string" ? candidate.id : `tool-${index}`,
          )
          ? []
          : [
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

function assistantToolCallIds(message: AgentMessage | undefined): Set<string> {
  if (!message || message.role !== "assistant") {
    return new Set();
  }

  return new Set(
    normalizeBlocks((message as AssistantLikeMessage).content).flatMap((block) =>
      block.type === "toolCall" ? [block.id] : [],
    ),
  );
}

function assistantTurnPhase(message: AssistantLikeMessage): UiAssistantTurnPhase {
  if (message.stopReason === "toolUse") {
    return "intermediate";
  }

  if (message.stopReason !== "pending") {
    return "final";
  }

  return normalizeBlocks(message.content).some((block) => block.type === "toolCall")
    ? "intermediate"
    : "pending";
}

function hasPersistedActiveAssistant(
  messages: AgentMessage[],
  activeAssistant: AgentMessage | undefined,
): boolean {
  const activeToolCallIds = assistantToolCallIds(activeAssistant);
  return (
    activeToolCallIds.size > 0 &&
    messages.some((message) =>
      [...assistantToolCallIds(message)].some((toolCallId) => activeToolCallIds.has(toolCallId)),
    )
  );
}

function messageId(prefix: string, timestamp: number, index: number): string {
  return `${prefix}-${timestamp}-${index}`;
}

export function normalizeMessage(
  message: AgentMessage,
  index: number,
  options: NormalizeOptions = {},
): UiMessage | undefined {
  if ((message as { display?: unknown }).display === false) {
    return undefined;
  }

  if (message.role === "user") {
    return {
      id: messageId("user", message.timestamp, index),
      role: "user",
      timestamp: message.timestamp,
      clientMessageId: message.clientMessageId,
      blocks: [
        ...normalizeUserBlocks(message.content, options),
        ...normalizeBattyAttachments(message),
      ],
    };
  }

  if (message.role === "assistant") {
    const assistant = message as AssistantLikeMessage;
    return {
      id: messageId("assistant", assistant.timestamp, index),
      role: "assistant",
      timestamp: assistant.timestamp,
      turnPhase: assistantTurnPhase(assistant),
      blocks: normalizeBlocks(assistant.content, options),
      model: assistant.model,
      provider: assistant.provider,
      stopReason: assistant.stopReason,
      errorMessage: assistant.errorMessage,
      fileChanges: assistant.battyFileChanges,
    };
  }

  if (message.role === "toolResult") {
    if (options.includeToolDetails === false) {
      return undefined;
    }
    const toolResult = message as ToolResultLikeMessage;
    const blocks = normalizeBlocks(toolResult.content, options);
    return {
      id: messageId("tool", toolResult.timestamp, index),
      role: "toolResult",
      timestamp: toolResult.timestamp,
      toolCallId: toolResult.toolCallId,
      toolName: toolResult.toolName,
      blocks: isPiShellToolName(toolResult.toolName) ? sanitizeTerminalBlocks(blocks) : blocks,
      isError: toolResult.isError,
      details: normalizeToolDetails(toolResult.details),
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
          : normalizeBlocks(custom.content, options)
              .map((block) =>
                "text" in block ? block.text : block.type === "thinking" ? block.thinking : "",
              )
              .join("\n")
              .trim(),
      data: normalizeCustomData(custom.data),
    };
  }

  return undefined;
}

export function normalizeMessages(
  messages: AgentMessage[],
  offset = 0,
  options: NormalizeOptions = {},
): UiMessage[] {
  return messages
    .map((message, index) => normalizeMessage(message, index + offset, options))
    .filter((message): message is UiMessage => Boolean(message));
}

type TranscriptSessionEntry = {
  type?: unknown;
  id?: unknown;
  message?: unknown;
  customType?: unknown;
  content?: unknown;
  timestamp?: unknown;
  data?: unknown;
};

export function transcriptMessagesFromSessionEntries(
  entries: TranscriptSessionEntry[],
  metadataEntries: TranscriptSessionEntry[] = entries,
): AgentMessage[] {
  const fileChangesByReplyId = agentTurnFileChangesByReplyEntryId(metadataEntries);
  return entries.flatMap((entry) => {
    if (entry?.type === "message" && entry.message) {
      const message = entry.message as AgentMessage;
      const fileChanges =
        message.role === "assistant" && typeof entry.id === "string"
          ? fileChangesByReplyId.get(entry.id)
          : undefined;
      return fileChanges
        ? [{ ...message, battyFileChanges: fileChanges } as unknown as AgentMessage]
        : [message];
    }

    if (
      entry?.type === "custom_message" &&
      typeof entry.customType === "string" &&
      typeof entry.content === "string"
    ) {
      const timestamp =
        typeof entry.timestamp === "number"
          ? entry.timestamp
          : typeof entry.timestamp === "string"
            ? Date.parse(entry.timestamp)
            : Date.now();
      return [
        {
          role: "custom",
          customType: entry.customType,
          content: entry.content,
          timestamp,
          data: normalizeCustomData(entry.data),
        } as unknown as AgentMessage,
      ];
    }

    return [];
  });
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
  queuedPrompts?: SessionState["queuedPrompts"];
  updatedAt: number;
  contextTokens: number | null;
  contextWindow: number | null;
  contextPercent: number | null;
  totalMessageCount: number;
  hasMoreMessages: boolean;
  messageIndexOffset?: number;
  messagesDetailLevel?: "summary" | "full";
  messages: AgentMessage[];
  activeAssistant?: AgentMessage;
  title?: string;
  isSubagentSession?: boolean;
  isCronSession?: boolean;
  activeTools: SessionState["activeTools"];
  revision?: number;
  imageResolver?: UiImageResolver;
}

export function createSessionState(input: SessionStateInput): SessionState {
  const activeAssistantPersisted = hasPersistedActiveAssistant(
    input.messages,
    input.activeAssistant,
  );
  const activeToolCallIds = assistantToolCallIds(input.activeAssistant);
  const activeAssistant =
    !activeAssistantPersisted && input.activeAssistant?.role === "assistant"
      ? (normalizeMessage(input.activeAssistant, Number.MAX_SAFE_INTEGER, {
          imageResolver: input.imageResolver,
        }) as Extract<UiMessage, { role: "assistant" }> | undefined)
      : undefined;

  return {
    id: input.id,
    revision: input.revision,
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
    queuedPrompts: input.queuedPrompts ?? [],
    updatedAt: input.updatedAt,
    contextTokens: input.contextTokens,
    contextWindow: input.contextWindow,
    contextPercent: input.contextPercent,
    totalMessageCount: input.totalMessageCount,
    hasMoreMessages: input.hasMoreMessages,
    messagesDetailLevel: input.messagesDetailLevel ?? "full",
    messages: normalizeMessages(input.messages, input.messageIndexOffset ?? 0, {
      imageResolver: input.imageResolver,
      includeToolDetails: input.messagesDetailLevel !== "summary",
      includedToolCallIds: activeAssistantPersisted ? activeToolCallIds : undefined,
    }),
    activeAssistant,
    activeTools: input.messagesDetailLevel === "summary" ? [] : input.activeTools,
    title: input.title,
    isSubagentSession: input.isSubagentSession,
    isCronSession: input.isCronSession,
  };
}
