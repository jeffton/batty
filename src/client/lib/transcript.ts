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

function hasSentFiles(state: ToolDisplayState | undefined): boolean {
  return Array.isArray(state?.resultDetails?.sentFiles) && state.resultDetails.sentFiles.length > 0;
}

export function isAttachmentOutputToolCall(
  block: UiContentBlock,
  toolStatesByCallId: Map<string, ToolDisplayState>,
): boolean {
  if (block.type !== "toolCall") {
    return false;
  }

  const state = toolStatesByCallId.get(block.id);
  if (state?.status !== "success" || !hasSentFiles(state)) {
    return false;
  }

  return (
    block.name === "attach-files" || (block.name === "subagent" && state.resultBlocks.length === 0)
  );
}

function attachmentCarrierBlocks(
  message: UiMessage,
  toolStatesByCallId: Map<string, ToolDisplayState>,
): UiContentBlock[] {
  if (message.role !== "assistant") {
    return [];
  }

  const attachmentBlocks = message.blocks.filter((block) =>
    isAttachmentOutputToolCall(block, toolStatesByCallId),
  );
  if (attachmentBlocks.length === 0) {
    return [];
  }

  const hasOnlyAttachmentCallsAndThinking = message.blocks.every(
    (block) => block.type === "thinking" || isAttachmentOutputToolCall(block, toolStatesByCallId),
  );
  return hasOnlyAttachmentCallsAndThinking ? attachmentBlocks : [];
}

function isAttachmentCarrierMessage(
  message: UiMessage,
  toolStatesByCallId: Map<string, ToolDisplayState>,
): boolean {
  return attachmentCarrierBlocks(message, toolStatesByCallId).length > 0;
}

function attachmentBlockFromToolResult(
  message: Extract<UiMessage, { role: "toolResult" }>,
): UiContentBlock | undefined {
  const state: ToolDisplayState = {
    status: message.isError ? "error" : "success",
    resultBlocks: message.blocks,
    resultDetails: message.details,
  };
  if (
    !isAttachmentOutputToolCall(
      { type: "toolCall", id: message.toolCallId, name: message.toolName, arguments: {} },
      new Map([[message.toolCallId, state]]),
    )
  ) {
    return undefined;
  }

  return {
    type: "toolCall",
    id: message.toolCallId,
    name: message.toolName,
    arguments: {},
  };
}

export function mergeAttachmentCarrierIntoAssistant(
  message: Extract<UiMessage, { role: "assistant" }>,
  attachmentBlocks: UiContentBlock[],
): Extract<UiMessage, { role: "assistant" }> {
  return { ...message, blocks: [...message.blocks, ...attachmentBlocks] };
}

function acceptsPendingAttachmentBlocks(message: UiMessage): boolean {
  return (
    message.role === "assistant" &&
    message.blocks.some((block) => block.type === "text" || block.type === "image")
  );
}

export function buildTranscriptMessages(
  messages: UiMessage[],
  toolStateLookup: ToolStateLookup,
): TranscriptMessageView[] {
  const entries: TranscriptMessageView[] = [];
  let pendingAttachmentBlocks: UiContentBlock[] = [];
  let pendingAttachmentId = "attachment-carrier";
  let pendingAttachmentTimestamp = 0;

  for (const message of messages) {
    if (message.role === "toolResult") {
      if (toolStateLookup.referencedToolCallIds.has(message.toolCallId)) {
        continue;
      }

      const attachmentBlock = attachmentBlockFromToolResult(message);
      if (attachmentBlock) {
        if (pendingAttachmentBlocks.length === 0) {
          pendingAttachmentId = message.id;
          pendingAttachmentTimestamp = message.timestamp;
        }
        pendingAttachmentBlocks = [...pendingAttachmentBlocks, attachmentBlock];
        continue;
      }
    }

    if (
      message.role === "assistant" &&
      isAttachmentCarrierMessage(message, toolStateLookup.toolStatesByCallId)
    ) {
      if (pendingAttachmentBlocks.length === 0) {
        pendingAttachmentId = message.id;
        pendingAttachmentTimestamp = message.timestamp;
      }
      pendingAttachmentBlocks = [
        ...pendingAttachmentBlocks,
        ...attachmentCarrierBlocks(message, toolStateLookup.toolStatesByCallId),
      ];
      continue;
    }

    if (pendingAttachmentBlocks.length > 0 && message.role !== "assistant") {
      const attachmentMessage: Extract<UiMessage, { role: "assistant" }> = {
        id: pendingAttachmentId,
        role: "assistant",
        timestamp: pendingAttachmentTimestamp,
        blocks: pendingAttachmentBlocks,
      };
      entries.push({
        message: attachmentMessage,
        toolStatesByCallId: toolStatesForMessage(
          attachmentMessage,
          toolStateLookup.toolStatesByCallId,
        ),
      });
      pendingAttachmentBlocks = [];
      pendingAttachmentId = "attachment-carrier";
      pendingAttachmentTimestamp = 0;
    }

    const shouldMergePendingAttachments =
      pendingAttachmentBlocks.length > 0 && acceptsPendingAttachmentBlocks(message);
    const renderedMessage = shouldMergePendingAttachments
      ? mergeAttachmentCarrierIntoAssistant(
          message as Extract<UiMessage, { role: "assistant" }>,
          pendingAttachmentBlocks,
        )
      : message;

    entries.push({
      message: renderedMessage,
      toolStatesByCallId: toolStatesForMessage(renderedMessage, toolStateLookup.toolStatesByCallId),
    });

    if (shouldMergePendingAttachments) {
      pendingAttachmentBlocks = [];
      pendingAttachmentId = "attachment-carrier";
      pendingAttachmentTimestamp = 0;
    }
  }

  if (pendingAttachmentBlocks.length > 0) {
    const message: Extract<UiMessage, { role: "assistant" }> = {
      id: pendingAttachmentId,
      role: "assistant",
      timestamp: pendingAttachmentTimestamp,
      blocks: pendingAttachmentBlocks,
    };
    entries.push({
      message,
      toolStatesByCallId: toolStatesForMessage(message, toolStateLookup.toolStatesByCallId),
    });
  }

  return entries;
}

export function hasToolResultContent(
  blocks: UiContentBlock[],
  details?: { diff?: string; sentFiles?: unknown[] },
): boolean {
  return (
    blocks.length > 0 ||
    typeof details?.diff === "string" ||
    (Array.isArray(details?.sentFiles) && details.sentFiles.length > 0)
  );
}
