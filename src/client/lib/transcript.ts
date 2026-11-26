import type {
  ActiveToolRun,
  ToolExecutionDetails,
  UiContentBlock,
  UiMessage,
} from "@/shared/types";

export interface ToolDisplayState {
  status?: "running" | "success" | "error";
  resultBlocks: UiContentBlock[];
  resultDetails?: ToolExecutionDetails;
}

export interface ToolStateLookup {
  referencedToolCallIds: Set<string>;
  toolStatesByCallId: Map<string, ToolDisplayState>;
}

export interface TranscriptMessageView {
  message: UiMessage;
  toolStatesByCallId: Map<string, ToolDisplayState>;
}

export function buildToolStateLookup(
  messages: UiMessage[],
  activeTools: ActiveToolRun[],
): ToolStateLookup {
  const referencedToolCallIds = new Set<string>();
  const toolResultsByCallId = new Map<string, Extract<UiMessage, { role: "toolResult" }>>();

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

  const toolStatesByCallId = new Map<string, ToolDisplayState>();

  for (const [toolCallId, result] of toolResultsByCallId) {
    toolStatesByCallId.set(toolCallId, {
      status: result.isError ? "error" : "success",
      resultBlocks: result.blocks,
      resultDetails: result.details,
    });
  }

  for (const tool of activeTools) {
    const persistedToolState = toolStatesByCallId.get(tool.toolCallId);
    if (persistedToolState) {
      continue;
    }

    toolStatesByCallId.set(tool.toolCallId, {
      status: tool.status,
      resultBlocks: tool.blocks,
      resultDetails: tool.details,
    });
  }

  return {
    referencedToolCallIds,
    toolStatesByCallId,
  };
}

export function toolStatesForMessage(
  message: UiMessage | undefined,
  toolStatesByCallId: Map<string, ToolDisplayState>,
): Map<string, ToolDisplayState> {
  const result = new Map<string, ToolDisplayState>();

  if (!message || !("blocks" in message)) {
    return result;
  }

  for (const block of message.blocks) {
    if (block.type !== "toolCall") {
      continue;
    }

    const toolState = toolStatesByCallId.get(block.id);
    if (toolState) {
      result.set(block.id, toolState);
    }
  }

  return result;
}

export function hasMessageAttachments(message: Extract<UiMessage, { role: "assistant" }>): boolean {
  return Boolean(message.sentFiles?.length || message.sites?.length || message.fileChanges?.length);
}

function assistantHasError(message: Extract<UiMessage, { role: "assistant" }>): boolean {
  return message.stopReason === "error" || Boolean(message.errorMessage?.trim());
}

function hiddenAssistantErrorIds(messages: UiMessage[], isStreaming: boolean): Set<string> {
  const hiddenIds = new Set<string>();
  let latestErrorId: string | undefined;

  for (const message of messages) {
    if (message.role === "user" || message.role === "custom") {
      latestErrorId = undefined;
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }

    if (latestErrorId) {
      hiddenIds.add(latestErrorId);
    }
    latestErrorId =
      assistantHasError(message) && !hasMessageAttachments(message) ? message.id : undefined;
  }

  if (isStreaming && latestErrorId) {
    hiddenIds.add(latestErrorId);
  }

  return hiddenIds;
}

function hasRenderableContent(message: Extract<UiMessage, { role: "assistant" }>): boolean {
  return (
    assistantHasError(message) ||
    hasMessageAttachments(message) ||
    message.blocks.some((block) => block.type !== "thinking" || block.thinking.trim().length > 0)
  );
}

export function buildTranscriptMessages(
  messages: UiMessage[],
  toolStateLookup: ToolStateLookup,
  isStreaming = false,
): TranscriptMessageView[] {
  const hiddenErrorIds = hiddenAssistantErrorIds(messages, isStreaming);
  return messages.flatMap((message) => {
    if (
      (message.role === "toolResult" &&
        toolStateLookup.referencedToolCallIds.has(message.toolCallId)) ||
      (message.role === "assistant" &&
        (hiddenErrorIds.has(message.id) || !hasRenderableContent(message)))
    ) {
      return [];
    }
    return [
      {
        message,
        toolStatesByCallId: toolStatesForMessage(message, toolStateLookup.toolStatesByCallId),
      },
    ];
  });
}

export function hasToolResultContent(
  blocks: UiContentBlock[],
  details?: ToolExecutionDetails,
): boolean {
  return blocks.length > 0 || typeof details?.diff === "string";
}
