import { decodeRuntimeNotice, encodeRuntimeNotice } from "./runtime-notices";

type RewriteLeaf = (value: unknown) => unknown;

type Bag = Record<string, unknown>;

const snapshotArrays = ["battyFileChanges"];
const patchArrays = ["fileChanges", "battyDeliveredFileChanges"];
const carriers = [
  "artifacts",
  "forwardedArtifacts",
  "referencedArtifacts",
  "runtimeResultArtifacts",
  "model",
  "details",
  "calls",
  "data",
  "original",
  "value",
  "message",
  "state",
  "checkpoint",
  "outcome",
  "result",
  "structuredOutput",
  "latestReport",
  "memos",
  "workers",
  "resultArtifacts",
  "items",
  "input",
  "entry",
  "notice",
  "tools",
  "nestedTools",
];
const maps = new Set(["workers", "resultArtifacts", "memos", "tools", "nestedTools"]);
export const artifactKeys = [...snapshotArrays, ...patchArrays, "batty-agent-turn-file-changes"];
const mayContainArtifact = new RegExp(artifactKeys.join("|"));

function bag(value: unknown): Bag | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Bag) : undefined;
}

function rewriteChanges(value: unknown, keys: readonly string[], rewrite: RewriteLeaf): void {
  for (const item of Array.isArray(value) ? value : [value]) {
    const change = bag(item);
    if (!change || typeof change.path !== "string") continue;
    for (const key of keys) {
      if (Object.hasOwn(change, key)) change[key] = rewrite(change[key]);
    }
  }
}

function rewriteNotice(content: string, rewrite: RewriteLeaf): string {
  const notice = decodeRuntimeNotice(content);
  if (!notice || encodeRuntimeNotice(notice) !== content) return content;
  rewriteCarrier(notice.data?.runtimeResultArtifacts, rewrite);
  return encodeRuntimeNotice(notice);
}

function rewriteCarrier(value: unknown, rewrite: RewriteLeaf): void {
  if (Array.isArray(value)) {
    for (const item of value) rewriteCarrier(item, rewrite);
    return;
  }
  const object = bag(value);
  if (!object) return;
  for (const key of snapshotArrays)
    rewriteChanges(object[key], ["before", "after", "patch"], rewrite);
  for (const key of patchArrays) rewriteChanges(object[key], ["patch"], rewrite);
  if (Array.isArray(object.battyFileChanges) && Object.hasOwn(object, "patch")) {
    object.patch = rewrite(object.patch);
  }
  if (object.customType === "batty-agent-turn-file-changes") {
    rewriteChanges(bag(object.data)?.files, ["patch"], rewrite);
  }
  for (const key of carriers) {
    const child = object[key];
    if (maps.has(key) && bag(child)) {
      for (const item of Object.values(child as Bag)) rewriteCarrier(item, rewrite);
    } else {
      rewriteCarrier(child, rewrite);
    }
  }
  if (typeof object.content === "string") object.content = rewriteNotice(object.content, rewrite);
  if (Array.isArray(object.content)) {
    const first = bag(object.content[0]);
    if (first?.type === "text" && typeof first.text === "string") {
      first.text = rewriteNotice(first.text, rewrite);
    }
  }
}

/** Pi revisions store either a full value or compact chord operations. Hydrate before applying operations. */
function rewriteOperations(operations: unknown[], rewrite: RewriteLeaf): void {
  for (const operation of operations) {
    if (!Array.isArray(operation)) continue;
    if (operation[0] === "r") {
      rewriteCarrier(operation[1], rewrite);
      continue;
    }
    if (!["s", "p"].includes(String(operation[0])) || !Array.isArray(operation[1])) continue;
    const path: unknown[] = operation[1];
    if (path.some((key) => key === "args" || key === "arguments" || key === "output")) continue;
    const slot = operation[0] === "s" ? 2 : 4;
    const snapshot = path.findIndex((key) => snapshotArrays.includes(String(key)));
    const patch = path.findIndex((key) => patchArrays.includes(String(key)));
    const index = snapshot === -1 ? patch : snapshot;
    const keys = snapshot === -1 ? ["patch"] : ["before", "after", "patch"];
    if (index !== -1 && path.length <= index + 2) {
      rewriteChanges(operation[slot], keys, rewrite);
    } else if (index !== -1 && path.length === index + 3 && keys.includes(String(path.at(-1)))) {
      operation[slot] = rewrite(operation[slot]);
    } else if (path.at(-1) === "content" && typeof operation[slot] === "string") {
      operation[slot] = rewriteNotice(operation[slot], rewrite);
    } else {
      rewriteCarrier(operation[slot], rewrite);
    }
  }
}

export function rewriteArtifactRow(raw: string, rewrite: RewriteLeaf, delta = false): string {
  if (!mayContainArtifact.test(raw)) return raw;
  const value: unknown = JSON.parse(raw);
  let changed = false;
  const track: RewriteLeaf = (value) => {
    const replacement = rewrite(value);
    changed ||= replacement !== value;
    return replacement;
  };
  if (delta && Array.isArray(value)) rewriteOperations(value, track);
  else rewriteCarrier(value, track);
  return changed ? JSON.stringify(value) : raw;
}
