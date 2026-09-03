import { easyModeMessage } from "@/client/lib/easy-mode";
import { isAttachmentOutputToolCall } from "@/client/lib/transcript";
import type { ToolDisplayState, TranscriptMessageView } from "@/client/lib/transcript";

interface DetailsToggle {
  sectionKey: string;
  expanded: boolean;
}

export type TranscriptDisplayEntry =
  | {
      kind: "message";
      entry: TranscriptMessageView;
      showTimestamp: boolean;
      detailsToggleBeforeReply?: DetailsToggle;
    }
  | ({ kind: "details-toggle" } & DetailsToggle);

export interface TranscriptDisplayResult {
  entries: TranscriptDisplayEntry[];
  latestExpandedSectionKey?: string;
}

interface TranscriptSection {
  key: string;
  startIndex: number;
  endIndex: number;
}

function startsAnyTurn(entry: TranscriptMessageView): boolean {
  return entry.message.role === "user" || entry.message.role === "custom";
}

function isDetachedCronTurnStart(entry: TranscriptMessageView): boolean {
  return entry.message.role === "custom" && Boolean(entry.message.data?.cron);
}

function startsExpandedTurn(entry: TranscriptMessageView): boolean {
  return startsAnyTurn(entry) && !isDetachedCronTurnStart(entry);
}

function sectionKey(entry: TranscriptMessageView | undefined, index: number): string {
  return entry ? `turn:${entry.message.id}` : `turn:${index}`;
}

function transcriptSections(entries: TranscriptMessageView[]): TranscriptSection[] {
  if (entries.length === 0) {
    return [];
  }

  const starts: number[] = [];
  entries.forEach((entry, index) => {
    if (index === 0 || startsAnyTurn(entry)) {
      starts.push(index);
    }
  });

  return starts.map((startIndex, index) => ({
    key: sectionKey(entries[startIndex], startIndex),
    startIndex,
    endIndex: starts[index + 1] ?? entries.length,
  }));
}

function latestExpandedSectionKey(
  sections: TranscriptSection[],
  entries: TranscriptMessageView[],
): string | undefined {
  const latestExpandedTurnIndex = entries.findLastIndex(startsExpandedTurn);
  if (latestExpandedTurnIndex < 0) {
    return undefined;
  }

  return sections.find(
    (section) =>
      latestExpandedTurnIndex >= section.startIndex && latestExpandedTurnIndex < section.endIndex,
  )?.key;
}

function collapsedMessage(
  entry: TranscriptMessageView,
  toolStatesByCallId: Map<string, ToolDisplayState>,
): TranscriptMessageView | undefined {
  const message = easyModeMessage(entry.message, toolStatesByCallId);
  return message ? { ...entry, message } : undefined;
}

function hasExpandableDetails(entry: TranscriptMessageView): boolean {
  const message = entry.message;
  if (message.role === "custom" && Boolean(message.data?.cron)) {
    return true;
  }

  if (message.role === "toolResult" || message.role === "bashExecution") {
    return true;
  }

  return (
    "blocks" in message &&
    message.blocks.some(
      (block) =>
        block.type === "toolCall" ||
        (block.type === "thinking" && block.thinking.trim().length > 0),
    )
  );
}

function hidesExpandableDetails(
  original: TranscriptMessageView,
  collapsed: TranscriptMessageView | undefined,
): boolean {
  if (!hasExpandableDetails(original)) {
    return false;
  }

  if (!collapsed) {
    return true;
  }

  const originalMessage = original.message;
  const collapsedMessage = collapsed.message;
  if (!("blocks" in originalMessage) || !("blocks" in collapsedMessage)) {
    return false;
  }

  return originalMessage.blocks.some(
    (block) =>
      (block.type === "toolCall" || block.type === "thinking") &&
      !collapsedMessage.blocks.includes(block),
  );
}

function detailsToggle(section: TranscriptSection, expanded: boolean): DetailsToggle {
  return {
    sectionKey: section.key,
    expanded,
  };
}

function hasAssistantReply(entry: TranscriptMessageView | undefined): boolean {
  if (!entry || entry.message.role !== "assistant") {
    return false;
  }

  if (
    entry.message.stopReason === "error" ||
    entry.message.errorMessage?.trim() ||
    (entry.message.fileChanges?.length ?? 0) > 0
  ) {
    return true;
  }

  if (
    entry.message.blocks.some((block) =>
      isAttachmentOutputToolCall(block, entry.toolStatesByCallId),
    )
  ) {
    return true;
  }

  const visibleBlocks = entry.message.blocks.filter(
    (block) => !isAttachmentOutputToolCall(block, entry.toolStatesByCallId),
  );
  const lastBlock = visibleBlocks.at(-1);
  return lastBlock?.type === "text" || lastBlock?.type === "image";
}

export function buildTranscriptDisplayEntries(
  entries: TranscriptMessageView[],
  toolStatesByCallId: Map<string, ToolDisplayState>,
  options: {
    alwaysShowDetails?: boolean;
    openDetailsSectionKey?: string | null;
    collapsedDetailsSectionKey?: string | null;
    showLatestDetailsToggle?: boolean;
  } = {},
): TranscriptDisplayResult {
  if (options.alwaysShowDetails) {
    return {
      entries: entries.map((entry) => ({ kind: "message", entry, showTimestamp: false })),
      latestExpandedSectionKey: undefined,
    };
  }

  const sections = transcriptSections(entries);
  const latestSectionKey = latestExpandedSectionKey(sections, entries);
  const displayEntries: TranscriptDisplayEntry[] = [];

  for (const section of sections) {
    const isLatestSection = section.key === latestSectionKey;
    const isOpenSection = section.key === options.openDetailsSectionKey;
    const canToggleSection = !isLatestSection || options.showLatestDetailsToggle === true;
    const isCollapsedSection =
      isLatestSection && section.key === options.collapsedDetailsSectionKey;
    const isExpanded = (isLatestSection && !isCollapsedSection) || isOpenSection;
    const sectionEntries = entries.slice(section.startIndex, section.endIndex);
    const items = sectionEntries.map((entry) => {
      const collapsed = collapsedMessage(entry, toolStatesByCallId);
      return {
        entry,
        collapsed,
        visibleEntry: isExpanded ? entry : collapsed,
        hidesDetails: hidesExpandableDetails(entry, collapsed),
      };
    });
    const firstHiddenIndex = canToggleSection ? items.findIndex((item) => item.hidesDetails) : -1;
    let toggleAfterIndex = -1;
    if (firstHiddenIndex >= 0) {
      toggleAfterIndex = firstHiddenIndex;
      for (let index = firstHiddenIndex + 1; index < items.length; index += 1) {
        if (!items[index]!.hidesDetails) {
          break;
        }
        toggleAfterIndex = index;
      }
    }

    items.forEach((item, index) => {
      const toggle = index === toggleAfterIndex ? detailsToggle(section, isExpanded) : undefined;
      const placeToggleBeforeReply = toggle && hasAssistantReply(item.visibleEntry);

      if (item.visibleEntry) {
        displayEntries.push({
          kind: "message",
          entry: item.visibleEntry,
          showTimestamp: false,
          ...(placeToggleBeforeReply ? { detailsToggleBeforeReply: toggle } : {}),
        });
      }

      if (toggle && !placeToggleBeforeReply) {
        displayEntries.push({ kind: "details-toggle", ...toggle });
      }
    });
  }

  return {
    entries: displayEntries,
    latestExpandedSectionKey: latestSectionKey,
  };
}
