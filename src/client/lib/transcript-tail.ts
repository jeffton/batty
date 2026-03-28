export interface HistoryAndTailSplit<T> {
  historyEntries: T[];
  tailEntries: T[];
}

export function splitHistoryAndTail<T>(entries: T[], tailCount: number): HistoryAndTailSplit<T> {
  const normalizedTailCount = Math.max(0, Math.floor(tailCount));
  const tailStartIndex = Math.max(0, entries.length - normalizedTailCount);

  return {
    historyEntries: entries.slice(0, tailStartIndex),
    tailEntries: entries.slice(tailStartIndex),
  };
}
