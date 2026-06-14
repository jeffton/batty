import { easyModeMessage } from "@/client/lib/easy-mode";
import type { ToolDisplayState, TranscriptMessageView } from "@/client/lib/transcript";

export type TranscriptDisplayEntry =
  | { kind: "message"; entry: TranscriptMessageView; showTimestamp: boolean }
  | { kind: "tool-toggle"; sectionKey: string; expanded: boolean };

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

function hidesToolDetails(
  original: TranscriptMessageView,
  collapsed: TranscriptMessageView | undefined,
): boolean {
  if (!collapsed) {
    return true;
  }

  if (!("blocks" in original.message) || !("blocks" in collapsed.message)) {
    return false;
  }

  return original.message.blocks.length !== collapsed.message.blocks.length;
}

function toggleEntry(section: TranscriptSection, expanded: boolean): TranscriptDisplayEntry {
  return {
    kind: "tool-toggle",
    sectionKey: section.key,
    expanded,
  };
}

export function buildTranscriptDisplayEntries(
  entries: TranscriptMessageView[],
  toolStatesByCallId: Map<string, ToolDisplayState>,
  options: {
    alwaysShowToolCalls?: boolean;
    openToolSectionKey?: string | null;
    collapsedToolSectionKey?: string | null;
    showLatestToolToggle?: boolean;
  } = {},
): TranscriptDisplayResult {
  if (options.alwaysShowToolCalls) {
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
    const isOpenSection = section.key === options.openToolSectionKey;
    const canToggleSection = !isLatestSection || options.showLatestToolToggle === true;
    const isCollapsedSection = isLatestSection && section.key === options.collapsedToolSectionKey;
    const isExpanded = (isLatestSection && !isCollapsedSection) || isOpenSection;
    const sectionEntries = entries.slice(section.startIndex, section.endIndex);
    const items = sectionEntries.map((entry) => {
      const collapsed = collapsedMessage(entry, toolStatesByCallId);
      return {
        entry,
        collapsed,
        visibleEntry: isExpanded ? entry : collapsed,
        hidesDetails: hidesToolDetails(entry, collapsed),
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
      if (item.visibleEntry) {
        displayEntries.push({ kind: "message", entry: item.visibleEntry, showTimestamp: false });
      }

      if (index === toggleAfterIndex) {
        displayEntries.push(toggleEntry(section, isExpanded));
      }
    });
  }

  return {
    entries: displayEntries,
    latestExpandedSectionKey: latestSectionKey,
  };
}
