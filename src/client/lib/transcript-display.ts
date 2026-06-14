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

function shouldPlaceToggleBeforeMessage(
  original: TranscriptMessageView,
  collapsed: TranscriptMessageView | undefined,
): boolean {
  if (!collapsed) {
    return true;
  }

  if (!("blocks" in original.message) || !("blocks" in collapsed.message)) {
    return false;
  }

  const originalMessage = original.message;
  const collapsedMessage = collapsed.message;
  if (!("blocks" in originalMessage) || !("blocks" in collapsedMessage)) {
    return false;
  }

  const firstVisibleIndex = originalMessage.blocks.findIndex((block) =>
    collapsedMessage.blocks.includes(block),
  );
  const firstHiddenIndex = originalMessage.blocks.findIndex(
    (block) => !collapsedMessage.blocks.includes(block),
  );

  return firstHiddenIndex >= 0 && (firstVisibleIndex < 0 || firstHiddenIndex <= firstVisibleIndex);
}

export function buildTranscriptDisplayEntries(
  entries: TranscriptMessageView[],
  toolStatesByCallId: Map<string, ToolDisplayState>,
  options: {
    alwaysShowToolCalls?: boolean;
    openToolSectionKey?: string | null;
    collapsedToolSectionKey?: string | null;
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
    const isCollapsedSection = section.key === options.collapsedToolSectionKey;
    const isExpanded = (isLatestSection && !isCollapsedSection) || isOpenSection;
    let insertedToolToggle = false;

    for (let index = section.startIndex; index < section.endIndex; index += 1) {
      const entry = entries[index] as TranscriptMessageView;
      const collapsed = collapsedMessage(entry, toolStatesByCallId);
      const visibleEntry = isExpanded ? entry : collapsed;
      const showToggleHere = !insertedToolToggle && hidesToolDetails(entry, collapsed);
      const toggleBeforeMessage =
        showToggleHere && shouldPlaceToggleBeforeMessage(entry, collapsed);

      if (toggleBeforeMessage) {
        displayEntries.push(toggleEntry(section, isExpanded));
        insertedToolToggle = true;
      }

      if (visibleEntry) {
        displayEntries.push({ kind: "message", entry: visibleEntry, showTimestamp: false });
      }

      if (showToggleHere && !toggleBeforeMessage) {
        displayEntries.push(toggleEntry(section, isExpanded));
        insertedToolToggle = true;
      }
    }
  }

  return {
    entries: displayEntries,
    latestExpandedSectionKey: latestSectionKey,
  };
}
