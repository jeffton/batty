import type { MemoryLeaf } from "./memory-projection";
import { key } from "./memory-view";

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

export function planNoiseCleanup(
  leaves: ReadonlyMap<number, MemoryLeaf>,
  nodes: ReadonlyMap<string, string>,
) {
  const excluded = [...leaves].filter(([, leaf]) => isMemoryNoise(leaf)).map(([id]) => id);
  const affected = new Set<string>();
  for (const id of excluded) {
    for (let count = 1; count <= leaves.size; count *= 2) {
      const name = key({ start: Math.floor(id / count) * count, count });
      if (nodes.has(name)) affected.add(name);
    }
  }
  const updates = new Map<string, string>();
  for (const name of [...affected].sort(
    (a, b) => Number(a.split("+")[1]) - Number(b.split("+")[1]),
  )) {
    const [start, count] = name.split("+").map(Number) as [number, number];
    let text = "";
    if (count > 1) {
      const child = (id: number) => {
        const name = key({ start: id, count: count / 2 });
        return updates.get(name) ?? nodes.get(name)!;
      };
      const left = child(start);
      const right = child(start + count / 2);
      // Reuse intact summaries instead of paying to regenerate the whole tree.
      text = !left ? right : !right ? left : stripNoiseClauses(nodes.get(name)!);
      // A lossy old parent may have kept only noise from a mixed subtree.
      if (!text && (left || right)) text = [left, right].filter(Boolean).join("; ");
    }
    if (text !== nodes.get(name)) updates.set(name, text);
  }
  return { excluded, affected: affected.size, updates };
}
