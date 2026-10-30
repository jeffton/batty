import type { Context } from "@earendil-works/chord";
import type { MemorySnapshot } from "./memory-documents";
import type { MemoryLeaf } from "./memory-projection";
import { key, renderView, type Part } from "./memory-view";

export function snapshotView(view: string, snapshot: MemorySnapshot) {
  return `${view}\n<!-- batty-optchat:${JSON.stringify(snapshot)} -->`;
}

export function snapshotFromView(view: string): MemorySnapshot | undefined {
  const metadata = /\n<!-- batty-optchat:(.*?) -->$/.exec(view);
  return metadata ? JSON.parse(metadata[1]!) : undefined;
}

type SnapshotSource = {
  count: number;
  prepared: number;
  generation: number;
  parts: readonly Part[];
  leaf: (id: number, context: Context) => Promise<MemoryLeaf>;
  node: (part: Part, context: Context, generation: number) => Promise<string>;
};

export async function captureMemorySnapshot(
  source: SnapshotSource,
  maximum: number,
  context: Context,
) {
  // Search or another turn may already have indexed entries beyond this input.
  let low = 0,
    high = source.count;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((await source.leaf(middle, context)).source <= maximum) low = middle + 1;
    else high = middle;
  }
  const count = low;
  const prepared = Math.min(source.prepared, count);
  const parts: Part[] = [];
  const nodes = new Map<string, string>();
  async function include(part: Part): Promise<void> {
    if (part.start >= prepared) return;
    if (part.start + part.count > prepared) {
      await include({ start: part.start, count: part.count / 2 });
      await include({ start: part.start + part.count / 2, count: part.count / 2 });
      return;
    }
    parts.push(part);
    nodes.set(key(part), await source.node(part, context, source.generation));
  }
  for (const part of source.parts) await include(part);
  const view = renderView(parts, nodes);
  return {
    view,
    snapshot: { generation: source.generation, count, prepared },
  };
}
