import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { EntryId, Storage } from "@earendil-works/pi-durable";
import type { MemoryIndex, MemorySnapshot } from "./memory-documents";
import { projectEntry, type MemoryLeaf } from "./memory-projection";
import { key, utf8Bytes, type Part } from "./memory-view";

export function createMemoryReader({
  load,
  getIndex,
  getOverview,
  leafAt,
  nodeAt,
  entry,
}: {
  load: (context: Context) => Promise<void>;
  getIndex: () => MemoryIndex;
  getOverview: () => { parts: Part[]; generation: number };
  leafAt: (id: number, context: Context) => Promise<MemoryLeaf>;
  nodeAt: (part: Part, context: Context, generation: number) => Promise<string | undefined>;
  entry: (id: EntryId, context: Context) => ReturnType<Storage["entry"]>;
}) {
  async function zoom(
    id: number,
    count: number,
    context = BACKGROUND_CONTEXT,
    snapshot?: MemorySnapshot,
  ) {
    await load(context);
    if (
      !Number.isInteger(id) ||
      !Number.isInteger(count) ||
      count < 1 ||
      Math.log2(count) % 1 !== 0 ||
      id < 0 ||
      id % count !== 0 ||
      id + count > getIndex().count
    )
      throw new Error(`No line ${id}+${count}`);
    if (count === 1) {
      const leaf = await leafAt(id, context);
      return `${id}+0|[${leaf.date}] ${leaf.kind}: ${leaf.text}`;
    }
    if (snapshot && id + count > snapshot.prepared)
      throw new Error(`No prepared line ${id}+${count} in this memory snapshot`);
    const generation = snapshot?.generation ?? getIndex().generation ?? 0;
    const children = [
      { start: id, count: count / 2 },
      { start: id + count / 2, count: count / 2 },
    ].map(async (part) => {
      const startDate = (await leafAt(part.start, context)).date;
      const endDate = (await leafAt(part.start + part.count - 1, context)).date;
      return `${key(part)}|[${startDate} .. ${endDate}] ${(await nodeAt(part, context, generation)) ?? "(not summarized yet: zoom it)"}`;
    });
    return (await Promise.all(children)).join("\n");
  }
  async function zoomOutput(
    id: number,
    count: number,
    context: Context,
    snapshot?: MemorySnapshot,
  ): Promise<(TextContent | ImageContent)[]> {
    const output: (TextContent | ImageContent)[] = [
      { type: "text", text: await zoom(id, count, context, snapshot) },
    ];
    if (count !== 1) return output;
    const leaf = await leafAt(id, context);
    const record = await entry(leaf.source as EntryId, context);
    if (!record) throw new Error(`Missing original entry for memory message ${id}`);
    // Ordinals count projected leaves, not model messages: assistants can emit
    // separate text and tool-call leaves, while system/thinking emit none.
    let ordinal = leaf.ordinal;
    for (const message of record.entry.model ?? []) {
      const count = projectEntry({ ...record.entry, model: [message] }).length;
      if (ordinal < count) {
        if (
          (message.role === "user" || message.role === "toolResult") &&
          typeof message.content !== "string"
        )
          output.push(...message.content.filter((part) => part.type === "image"));
        return output;
      }
      ordinal -= count;
    }
    throw new Error(`Missing original message for memory message ${id}`);
  }
  async function browserSummary(part: Part, generation: number, context = BACKGROUND_CONTEXT) {
    const text = await nodeAt(part, context, generation);
    const summary =
      text === ""
        ? "(silent runtime noise excluded; original available below)"
        : (text ?? "(not summarized yet: zoom it)");
    return {
      id: part.start,
      count: part.count,
      summary,
      bytes: utf8Bytes(summary),
      startDate: (await leafAt(part.start, context)).date,
      endDate: (await leafAt(part.start + part.count - 1, context)).date,
    };
  }
  async function date(id: number, context = BACKGROUND_CONTEXT) {
    await load(context);
    if (!Number.isSafeInteger(id) || id < 0 || id >= getIndex().count)
      throw new Error(`No message ${id}`);
    const leaf = await leafAt(id, context);
    return leaf.date;
  }
  async function browserOverview() {
    const { parts, generation } = getOverview();
    return {
      nodes: await Promise.all(parts.map((part) => browserSummary(part, generation))),
      prepared: parts.reduce((total, part) => total + part.count, 0),
      total: getIndex().count,
    };
  }
  async function browserNode(id: number, count: number) {
    if (
      !Number.isSafeInteger(id) ||
      !Number.isSafeInteger(count) ||
      count < 1 ||
      Math.log2(count) % 1 !== 0 ||
      id < 0 ||
      id % count !== 0 ||
      id + count > getIndex().viewCount
    )
      throw new RangeError(`No prepared line ${id}+${count}`);
    const generation = getIndex().generation ?? 0;
    if (count === 1) return { children: [], text: await zoom(id, count) };
    return {
      children: [
        await browserSummary({ start: id, count: count / 2 }, generation),
        await browserSummary({ start: id + count / 2, count: count / 2 }, generation),
      ],
    };
  }
  return { zoom, zoomOutput, date, browserOverview, browserNode };
}
