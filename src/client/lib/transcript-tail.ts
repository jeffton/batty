export interface HistoryAndTailSplit<T> {
  historyEntries: T[];
  tailEntries: T[];
}

export function splitHistoryAndTail<T>(entries: T[], tailCount: number): HistoryAndTailSplit<T> {
  const tailStartIndex = Math.max(0, entries.length - Math.floor(tailCount));

  return {
    historyEntries: entries.slice(0, tailStartIndex),
    tailEntries: entries.slice(tailStartIndex),
  };
}
