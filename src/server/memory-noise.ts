import type { MemoryLeaf } from "./memory-projection";

// Keep archive positions even for silent turns: zoom/date must retain their IDs.
export function isMemoryNoise(leaf: Pick<MemoryLeaf, "kind" | "text">): boolean {
  if (leaf.kind === "talk") return leaf.text.trim() === "NO_REPLY";
  return (
    leaf.kind === "note" &&
    /^Runtime (?:cron|subagent): \[(?:cron|subagent) \d+ result\]\s*NO_REPLY$/.test(
      leaf.text.trim(),
    )
  );
}

export function stripNoiseClauses(text: string): string {
  // Only complete tagged clauses, never arbitrary mentions of the sentinel.
  return text
    .split(/;\s*|\n/)
    .filter(
      (clause) =>
        !/^talk:\s*(?:\d+\s*[×x]\s*)?`?NO_REPLY`?(?:\s*[×x]\s*\d+)?\.?$/.test(clause.trim()) &&
        !/^note:\s*Runtime (?:cron|subagent): \[(?:cron|subagent) \d+ result\]\s*NO_REPLY\.?$/.test(
          clause.trim(),
        ),
    )
    .join("; ");
}
