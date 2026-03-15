export interface DiffLineView {
  kind: "context" | "add" | "remove" | "ellipsis" | "meta";
  prefix: string;
  oldNumber?: string;
  newNumber?: string;
  html: string;
}

type LineOp =
  | { kind: "context"; text: string; oldNumber: number; newNumber: number }
  | { kind: "add"; text: string; newNumber: number }
  | { kind: "remove"; text: string; oldNumber: number }
  | { kind: "ellipsis" };

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function commonSuffixLength(left: string, right: string, prefixLength: number): number {
  const leftRemaining = left.length - prefixLength;
  const rightRemaining = right.length - prefixLength;
  const limit = Math.min(leftRemaining, rightRemaining);
  let index = 0;

  while (index < limit && left[left.length - 1 - index] === right[right.length - 1 - index]) {
    index += 1;
  }

  return index;
}

function renderInlineDiff(oldText: string, newText: string): { oldHtml: string; newHtml: string } {
  const prefixLength = commonPrefixLength(oldText, newText);
  const suffixLength = commonSuffixLength(oldText, newText, prefixLength);
  const oldChangedEnd = oldText.length - suffixLength;
  const newChangedEnd = newText.length - suffixLength;
  const oldChanged = oldText.slice(prefixLength, oldChangedEnd);
  const newChanged = newText.slice(prefixLength, newChangedEnd);

  if (!oldChanged && !newChanged) {
    return {
      oldHtml: escapeHtml(oldText),
      newHtml: escapeHtml(newText),
    };
  }

  const prefix = escapeHtml(oldText.slice(0, prefixLength));
  const oldMiddle = `<span class="diff-block__inline-change">${escapeHtml(oldChanged)}</span>`;
  const newMiddle = `<span class="diff-block__inline-change">${escapeHtml(newChanged)}</span>`;
  const suffix = suffixLength > 0 ? escapeHtml(oldText.slice(oldChangedEnd)) : "";

  return {
    oldHtml: `${prefix}${oldMiddle}${suffix}`,
    newHtml: `${prefix}${newMiddle}${suffix}`,
  };
}

function splitLines(text: string): string[] {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
}

function buildLineDiff(oldLines: string[], newLines: string[]): LineOp[] {
  const rows = oldLines.length;
  const cols = newLines.length;
  const dp = Array.from({ length: rows + 1 }, () => Array<number>(cols + 1).fill(0));

  for (let oldIndex = rows - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = cols - 1; newIndex >= 0; newIndex -= 1) {
      dp[oldIndex][newIndex] =
        oldLines[oldIndex] === newLines[newIndex]
          ? dp[oldIndex + 1][newIndex + 1] + 1
          : Math.max(dp[oldIndex + 1][newIndex], dp[oldIndex][newIndex + 1]);
    }
  }

  const operations: LineOp[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  let oldNumber = 1;
  let newNumber = 1;

  while (oldIndex < rows && newIndex < cols) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      operations.push({
        kind: "context",
        text: oldLines[oldIndex],
        oldNumber,
        newNumber,
      });
      oldIndex += 1;
      newIndex += 1;
      oldNumber += 1;
      newNumber += 1;
      continue;
    }

    if (dp[oldIndex + 1][newIndex] >= dp[oldIndex][newIndex + 1]) {
      operations.push({ kind: "remove", text: oldLines[oldIndex], oldNumber });
      oldIndex += 1;
      oldNumber += 1;
      continue;
    }

    operations.push({ kind: "add", text: newLines[newIndex], newNumber });
    newIndex += 1;
    newNumber += 1;
  }

  while (oldIndex < rows) {
    operations.push({ kind: "remove", text: oldLines[oldIndex], oldNumber });
    oldIndex += 1;
    oldNumber += 1;
  }

  while (newIndex < cols) {
    operations.push({ kind: "add", text: newLines[newIndex], newNumber });
    newIndex += 1;
    newNumber += 1;
  }

  return operations;
}

function collapseContext(operations: LineOp[], contextLines: number): LineOp[] {
  const collapsed: LineOp[] = [];
  let index = 0;

  while (index < operations.length) {
    const current = operations[index];
    if (current.kind !== "context") {
      collapsed.push(current);
      index += 1;
      continue;
    }

    let end = index;
    while (end < operations.length && operations[end]?.kind === "context") {
      end += 1;
    }

    const run = operations.slice(index, end);
    const prevIsChange = index > 0 && operations[index - 1]?.kind !== "context";
    const nextIsChange = end < operations.length && operations[end]?.kind !== "context";

    if (prevIsChange && nextIsChange && run.length > contextLines * 2) {
      collapsed.push(...run.slice(0, contextLines));
      collapsed.push({ kind: "ellipsis" });
      collapsed.push(...run.slice(-contextLines));
    } else if (!prevIsChange && nextIsChange && run.length > contextLines) {
      collapsed.push({ kind: "ellipsis" });
      collapsed.push(...run.slice(-contextLines));
    } else if (prevIsChange && !nextIsChange && run.length > contextLines) {
      collapsed.push(...run.slice(0, contextLines));
      collapsed.push({ kind: "ellipsis" });
    } else {
      collapsed.push(...run);
    }

    index = end;
  }

  return collapsed;
}

function toLineView(operation: LineOp): DiffLineView {
  if (operation.kind === "ellipsis") {
    return { kind: "ellipsis", prefix: "…", html: "..." };
  }

  if (operation.kind === "context") {
    return {
      kind: "context",
      prefix: " ",
      oldNumber: String(operation.oldNumber),
      newNumber: String(operation.newNumber),
      html: escapeHtml(operation.text),
    };
  }

  if (operation.kind === "remove") {
    return {
      kind: "remove",
      prefix: "-",
      oldNumber: String(operation.oldNumber),
      html: escapeHtml(operation.text),
    };
  }

  return {
    kind: "add",
    prefix: "+",
    newNumber: String(operation.newNumber),
    html: escapeHtml(operation.text),
  };
}

function decodeHtml(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

function enhanceInlinePairsFromText(lines: DiffLineView[]): DiffLineView[] {
  const enhanced: DiffLineView[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index];
    const next = lines[index + 1];

    if (current?.kind === "remove" && next?.kind === "add") {
      const { oldHtml, newHtml } = renderInlineDiff(
        decodeHtml(current.html),
        decodeHtml(next.html),
      );
      enhanced.push({ ...current, html: oldHtml });
      enhanced.push({ ...next, html: newHtml });
      index += 1;
      continue;
    }

    enhanced.push(current);
  }

  return enhanced;
}

export function createEditPreviewLines(
  oldText: string,
  newText: string,
  contextLines = 2,
): DiffLineView[] {
  const operations = collapseContext(
    buildLineDiff(splitLines(oldText), splitLines(newText)),
    contextLines,
  );
  return enhanceInlinePairsFromText(operations.map(toLineView));
}

function parseDiffLine(
  line: string,
): { prefix: "+" | "-" | " "; lineNumber?: string; text: string } | undefined {
  const match = line.match(/^([+\- ])(\s*\d*)\s(.*)$/);
  if (!match) {
    return undefined;
  }

  return {
    prefix: match[1] as "+" | "-" | " ",
    lineNumber: match[2].trim() || undefined,
    text: match[3],
  };
}

export function parseRenderedDiff(diffText: string): DiffLineView[] {
  const rawLines = diffText.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const lines: DiffLineView[] = [];

  for (const rawLine of rawLines) {
    if (!rawLine) {
      continue;
    }

    const parsed = parseDiffLine(rawLine);
    if (!parsed) {
      lines.push({ kind: "meta", prefix: "", html: escapeHtml(rawLine) });
      continue;
    }

    if (parsed.prefix === " " && parsed.text === "...") {
      lines.push({ kind: "ellipsis", prefix: "…", html: "..." });
      continue;
    }

    if (parsed.prefix === "-") {
      lines.push({
        kind: "remove",
        prefix: "-",
        oldNumber: parsed.lineNumber,
        html: escapeHtml(parsed.text),
      });
      continue;
    }

    if (parsed.prefix === "+") {
      lines.push({
        kind: "add",
        prefix: "+",
        newNumber: parsed.lineNumber,
        html: escapeHtml(parsed.text),
      });
      continue;
    }

    lines.push({
      kind: "context",
      prefix: " ",
      oldNumber: parsed.lineNumber,
      newNumber: parsed.lineNumber,
      html: escapeHtml(parsed.text),
    });
  }

  return enhanceInlinePairsFromText(lines);
}
