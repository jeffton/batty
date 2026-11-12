import type { Context } from "@earendil-works/chord";
import type { MemorySnapshot } from "./memory-documents";
import type { MemoryLeaf } from "./memory-projection";
import { key, renderView, type Part } from "./memory-view";

export function snapshotView(view: string, snapshot: MemorySnapshot) {
  return `${view}\n<!-- batty-optchat:${JSON.stringify(snapshot)} -->`;
}

// Workers inherit the prepared tree, not main's native pending messages.
// Pending originals stay searchable/zoomable, including their images. This also
// migrates persisted packets that inlined large raw subagent/artifact reports.
export function workerMemoryView(view: string, snapshot: MemorySnapshot) {
  const tree = view.slice(0, view.indexOf("\n</chat>") + "\n</chat>".length);
  const pending =
    snapshot.prepared < snapshot.count
      ? `\n<unprepared-main-memory>\nMain messages ${snapshot.prepared}–${snapshot.count - 1} are awaiting tree preparation. Retrieve complete originals and images with memory_zoom(id, 1), or locate them with memory_search.\n</unprepared-main-memory>`
      : "";
  return snapshotView(`${tree}${pending}`, snapshot);
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
