export type Part = { start: number; count: number };

export const VIEW_BYTES = 128_000;
export const utf8Bytes = (text: string) => Buffer.byteLength(text, "utf8");
export const key = (part: Part) => `${part.start}+${part.count}`;

export type ViewBatch = { merging?: boolean };
export function fitView(
  parts: Part[],
  total: number,
  nodes: Pick<ReadonlyMap<string, string>, "get" | "has">,
  budget = VIEW_BYTES,
  batch: ViewBatch = {},
): Part[] {
  const result = parts.map((part) => ({ ...part }));
  // Invisible leaves must not grow the cover indefinitely when its text is empty.
  for (let i = 0; i + 1 < result.length;) {
    const a = result[i]!,
      b = result[i + 1]!;
    const parent = { start: a.start, count: a.count * 2 };
    if (
      a.count === b.count &&
      a.start % parent.count === 0 &&
      b.start === a.start + a.count &&
      nodes.get(key(a)) === "" &&
      nodes.get(key(b)) === "" &&
      nodes.get(key(parent)) === ""
    ) {
      result.splice(i, 2, parent);
      i = Math.max(0, i - 1);
    } else i++;
  }
  const size = () =>
    result.reduce(
      (sum, part) => sum + utf8Bytes(nodes.get(key(part)) ?? "(not summarized yet: zoom it)"),
      0,
    );
  if (size() > budget) batch.merging = true;
  const target = budget / 2;
  while (batch.merging && size() > target) {
    let best = -1;
    let weight = -1;
    for (let i = 0; i + 1 < result.length; i++) {
      const a = result[i]!;
      const b = result[i + 1]!;
      if (
        a.count !== b.count ||
        a.start % (a.count * 2) !== 0 ||
        b.start !== a.start + a.count ||
        !nodes.has(key({ start: a.start, count: a.count * 2 }))
      )
        continue;
      // Zero-based archive: total is the exclusive end, as is the pair's end.
      const due = (total - (b.start + b.count)) / a.count;
      if (due > weight) {
        best = i;
        weight = due;
      }
    }
    if (best < 0) break;
    const part = result[best]!;
    result.splice(best, 2, { start: part.start, count: part.count * 2 });
  }
  if (size() <= target) batch.merging = false;
  return result;
}
export function renderView(
  parts: readonly Part[],
  nodes: ReadonlyMap<string, string>,
  ids = true,
): string {
  return `<chat>\n${parts
    .filter((part) => nodes.get(key(part)) !== "")
    .map(
      (part) =>
        `${ids ? `${key(part)}|` : ""}${(nodes.get(key(part)) ?? "(not summarized yet: zoom it)").replaceAll("\n", " ")}`,
    )
    .join("\n")}\n</chat>`;
}
