import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { BACKGROUND_CONTEXT, withCancel, awaitWithContext } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { ImageContent, Models, TextContent } from "@earendil-works/pi-ai";
import {
  LiveDoc,
  ProviderDoc,
  type Conversation,
  type EntryId,
  type EntryRecord,
  type Harness,
  type Storage,
} from "@earendil-works/pi-durable";
import type { MemorySearch, MemorySearchOptions } from "./memory-search";
import { ByteCache } from "../shared/byte-cache";
import {
  MemoryUsageDoc,
  accountMemoryCall,
  emptyMemoryUsage,
  type MemoryCall,
} from "./memory-usage";
import { projectEntry, type MemoryLeaf } from "./memory-projection";
import {
  key,
  fitView,
  renderView,
  utf8Bytes,
  VIEW_BYTES,
  type Part,
  type ViewBatch,
} from "./memory-view";
import { isMemoryNoise, stripNoiseClauses } from "./memory-noise";
import { createMemoryCompressor, MemoryFatalError, NODE_BYTES } from "./memory-compression";
import { createMemoryRequests } from "./memory-requests";
import { snapshotView, captureMemorySnapshot } from "./memory-snapshot";
import {
  Leaves,
  Generations,
  GenerationCounter,
  Rebuild,
  MemoryIndexDoc as Index,
  MemoryMaintenanceDoc as Maintenance,
  MemoryNodesDoc as Nodes,
  type MemoryIndex,
  type MemoryRebuild,
  type MemorySnapshot,
} from "./memory-documents";

export { projectEntry, type MemoryLeaf } from "./memory-projection";
export {
  fitView,
  renderView,
  utf8Bytes,
  VIEW_BYTES,
  type Part,
  type ViewBatch,
} from "./memory-view";
export { isMemoryNoise, stripNoiseClauses, planNoiseCleanup } from "./memory-noise";
export { COMPACT_PROMPT, compactPrompt, MASTER_PROMPT, VIEW_DOC } from "./memory-prompts";
export { NODE_BYTES } from "./memory-compression";
export { MemoryIndexDoc, MemoryMaintenanceDoc, MemoryNodesDoc } from "./memory-documents";

export type MemoryConfig = {
  getAssistantWorkspaceId?: () => Promise<string | undefined>;
  memoryLanguage?: string;
  memoryModel?: string | { provider: string; modelId: string };
  memoryReasoning?: "minimal" | "low" | "medium" | "high";
  nodeBytes?: number;
  viewBytes?: number;
  retryMs?: number;
  onError?: (error: unknown) => void;
  onProgress?: (progress: { completed: number; total: number; nodes: number }) => void;
  compress?: (source: string, signal?: AbortSignal) => Promise<string>;
  noiseBackupDir?: string;
  rebuildRequested?: boolean;
};

export function createMemory(config: MemoryConfig, models: Models) {
  let harness: Harness;
  let main: Conversation;
  let index: MemoryIndex;
  let loaded = false;
  let rootSessionId: string;
  let lastError: string | undefined;
  const background = withCancel(BACKGROUND_CONTEXT);
  let unsubscribe = () => {};
  let unsubscribeClose = () => {};
  let storage: Storage;
  let searchIndex: MemorySearch | undefined;
  async function indexSearch(context: Context) {
    if (!searchIndex) return;
    let next = await searchIndex.cursor(main.id);
    while (next < index.count) {
      context.abortSignal?.throwIfAborted();
      const leaves: MemoryLeaf[] = [];
      for (let id = next; id < Math.min(next + 128, index.count); id++)
        leaves.push(await leafAt(id, context));
      await searchIndex.append(main.id, next, leaves);
      next += leaves.length;
    }
  }
  async function search(options: MemorySearchOptions, context = BACKGROUND_CONTEXT) {
    return exclusive(async () => {
      if (!searchIndex) throw new Error("Memory search index is not configured");
      await syncTo(Number.MAX_SAFE_INTEGER, context);
      await indexSearch(context);
      return searchIndex.search(main.id, options);
    });
  }
  const cache = new ByteCache<MemoryLeaf | { text: string }>(2 * 1024 * 1024, (value) =>
    utf8Bytes(JSON.stringify(value)),
  );
  let maintenance: { generation: number; settled: number };
  let treeWrites = 0;
  // Only the current overview is pinned; cold branches never enter Pi's tracker cache.
  let overviewNodes = new Map<string, string>();
  let overviewParts: Part[] = [];
  let overviewGeneration = 0;
  async function readTree<T extends MemoryLeaf | { text: string }>(
    kind: string,
    name: string,
    context: Context,
  ): Promise<T | undefined> {
    const cacheKey = `${kind}:${name}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached as T;
    const record = await storage.findDocument(
      { kind, scope: { kind: "conversation", conversationId: main.id }, key: name },
      "current",
      context,
    );
    if (!record) return undefined;
    const value = (await storage.document(record.id, "current", context))!.value as T;
    cache.set(cacheKey, value);
    return value;
  }
  const leafAt = async (id: number, context: Context) =>
    (await readTree<MemoryLeaf>(Leaves.definition.kind, String(id), context))!;
  const parents = new Map<number, { parent: number; count: number } | null>();
  async function nodeAt(
    part: Part,
    context: Context,
    generation = index.generation ?? 0,
  ): Promise<string | undefined> {
    for (;;) {
      const node = await readTree<{ text: string }>(
        Nodes.definition.kind,
        storedKey(part, generation),
        context,
      );
      if (node !== undefined) return node.text;
      if (!parents.has(generation)) {
        const descriptor = await harness.snapshot(
          Generations,
          main.id,
          String(generation),
          context,
        );
        parents.set(generation, descriptor ? { ...descriptor } : null);
      }
      const parent = parents.get(generation)!;
      if (parent === null || part.start + part.count > parent.count) return undefined;
      generation = parent.parent;
    }
  }
  async function releaseTrackers(force = false) {
    // Pi exposes one mutation-line-safe unload operation. Observers subscribe to
    // publications, not tracker identity; unloading does not detach them.
    if (++treeWrites >= 64 || force) {
      treeWrites = 0;
      await (harness as Harness & { unloadDocuments(): Promise<void> }).unloadDocuments();
    }
  }
  async function fitParts(
    parts: Part[],
    total: number,
    context: Context,
    generation = index.generation ?? 0,
    batch: ViewBatch = index,
  ) {
    const available = new Map<string, string>();
    let result = parts;
    for (;;) {
      for (const part of result) {
        const text = await nodeAt(part, context, generation);
        if (text !== undefined) available.set(key(part), text);
      }
      for (let i = 0; i + 1 < result.length; i++) {
        const a = result[i]!,
          b = result[i + 1]!;
        if (a.count === b.count && a.start % (a.count * 2) === 0 && b.start === a.start + a.count) {
          const parent = { start: a.start, count: a.count * 2 };
          const text = await nodeAt(parent, context, generation);
          if (text !== undefined) available.set(key(parent), text);
        }
      }
      const next = fitView(result, total, available, budget, batch);
      if (next.length === result.length) return next;
      result = next;
    }
  }
  async function refreshOverview(context: Context) {
    const current = new Map<string, string>();
    const parts = index.parts.map((part) => ({ ...part }));
    const generation = index.generation ?? 0;
    for (const part of parts) {
      const text = await nodeAt(part, context, generation);
      if (text !== undefined) current.set(key(part), text);
    }
    // Publish one coherent generation to workers while maintenance is running.
    overviewNodes = current;
    overviewParts = parts;
    overviewGeneration = generation;
  }
  let serial: Promise<unknown> = Promise.resolve();
  let writer: Promise<unknown> = Promise.resolve();
  const writeExclusive = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = writer.then(operation);
    writer = result.catch(() => undefined);
    return result;
  };
  let rebuilding: Promise<void> | undefined;
  let rebuildError: string | undefined;
  let rebuildProgress:
    | { generation: number; total: number; completed: number; excluded: number }
    | undefined;
  const storedKey = (part: Part, generation = index.generation ?? 0) =>
    generation === 0 ? key(part) : `g${generation}:${key(part)}`;
  const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = serial.then(operation);
    serial = result.catch(() => undefined);
    return result;
  };
  const report = (error: unknown) => {
    lastError = String(error);
    (config.onError ?? ((failure: unknown) => console.error("OptChat:", failure)))(error);
  };
  const nodeBytes = config.nodeBytes ?? NODE_BYTES;
  const budget = config.viewBytes ?? VIEW_BYTES;
  async function load(context: Context) {
    if (loaded) return;
    const stored = await harness.snapshot(Index, main.id, context);
    index = stored ? structuredClone(stored) : { count: 0, cursor: 0, viewCount: 0, parts: [] };
    const checkpoint = await harness.snapshot(Maintenance, main.id, context);
    maintenance =
      checkpoint && checkpoint.generation === (index.generation ?? 0)
        ? structuredClone(checkpoint)
        : { generation: index.generation ?? 0, settled: 0 };
    await refreshOverview(context);
    loaded = true;
  }
  async function syncTo(maximum: number, context: Context) {
    await load(context);
    const ranges: { min: EntryId; max: EntryId }[] = [];
    let cursor;
    do {
      const page = await main.entries(
        { minEntryId: (index.cursor + 1) as EntryId, maxEntryId: maximum as EntryId },
        500,
        cursor,
        context,
      );
      if (page.items.length) ranges.push({ min: page.items.at(-1)!.id, max: page.items[0]!.id });
      cursor = page.next;
    } while (cursor);
    // Storage scans newest-first. Replay bounded pages oldest-first without retaining the entire raw archive.
    for (const range of ranges.reverse()) {
      const page = await main.entries(
        { minEntryId: range.min, maxEntryId: range.max },
        500,
        undefined,
        context,
      );
      for (const entry of [...page.items].reverse()) {
        const projected = projectEntry(entry);
        await main.commit(async (tx) => {
          const draft = await tx.doc(Index, main.id);
          if (draft.cursor >= entry.id) return;
          for (const leaf of projected) {
            await tx.doc(Leaves, main.id, String(draft.count), leaf);
            draft.count++;
          }
          draft.cursor = entry.id;
        }, context);
        for (const leaf of projected) {
          cache.set(`${Leaves.definition.kind}:${index.count}`, leaf);
          index.count++;
        }
        index.cursor = entry.id;
        await releaseTrackers();
      }
    }
  }
  async function recordMemoryCall(call: MemoryCall) {
    try {
      // The inference has already happened: persist accounting even when its caller aborts.
      await main.commit(async (tx) => {
        const totals = await tx.doc(MemoryUsageDoc, main.id);
        totals.since ??= call.startedAt;
        accountMemoryCall(totals[call.operation], call);
        await tx.appendEntry(main.id, {
          kind: "batty.memory-call",
          data: { ...call, usage: call.usage ? { ...call.usage } : null },
        });
      }, BACKGROUND_CONTEXT);
    } catch {
      throw new MemoryFatalError("Unable to persist memory usage accounting");
    }
  }
  async function childText(part: Part, context: Context, generation: number) {
    const text = await nodeAt(part, context, generation);
    if (text === undefined)
      throw new MemoryFatalError(`Missing memory child ${storedKey(part, generation)}`);
    return text;
  }
  async function build(
    part: Part,
    context: Context,
    generation = index.generation ?? 0,
    operation: MemoryCall["operation"] = "incremental",
    force = false,
  ) {
    const existing = await nodeAt(part, context, generation);
    if (!force && existing !== undefined) return;
    const leaf = part.count === 1 ? await leafAt(part.start, context) : undefined;
    const source = leaf
      ? isMemoryNoise(leaf)
        ? ""
        : `${leaf.kind}: ${leaf.text}`
      : [
          await childText({ start: part.start, count: part.count / 2 }, context, generation),
          await childText(
            { start: part.start + part.count / 2, count: part.count / 2 },
            context,
            generation,
          ),
        ]
          .filter(Boolean)
          .join("\n");
    const text = await compress(source.trim(), context, { ...part, operation, generation });
    await main.commit(async (tx) => {
      (await tx.doc(Nodes, main.id, storedKey(part, generation), { text })).text = text;
    }, context);
    cache.set(`${Nodes.definition.kind}:${storedKey(part, generation)}`, { text });
    await releaseTrackers();
    lastError = undefined;
  }
  async function publishPrefix(
    expected: { generation: number; settled: number },
    next: { settled: number; viewCount: number; parts: Part[]; merging?: boolean },
    context: Context,
  ) {
    await exclusive(async () => {
      await main.commit(async (tx) => {
        const draft = await tx.doc(Index, main.id);
        const checkpoint = await tx.doc(Maintenance, main.id);
        if (
          (draft.generation ?? 0) !== expected.generation ||
          checkpoint.generation !== expected.generation ||
          checkpoint.settled !== expected.settled
        )
          throw new Error("Memory checkpoint changed during maintenance");
        draft.viewCount = next.viewCount;
        draft.parts = next.parts;
        draft.merging = next.merging;
        checkpoint.settled = next.settled;
      }, context);
      index.viewCount = next.viewCount;
      index.parts = next.parts;
      index.merging = next.merging;
      maintenance = { generation: expected.generation, settled: next.settled };
      await refreshOverview(context);
      await releaseTrackers(true);
    });
  }
  async function allocateGeneration(context: Context) {
    const rebuild = await harness.snapshot(Rebuild, main.id, context);
    return main.commit(async (tx) => {
      const counter = await tx.doc(GenerationCounter, main.id);
      const generation = Math.max(
        counter.next,
        (index.generation ?? 0) + 1,
        (rebuild?.generation ?? 0) + 1,
      );
      counter.next = generation + 1;
      return generation;
    }, context);
  }
  async function cleanLegacyNoise(context: Context) {
    const parent = index.generation ?? 0;
    const generation = await allocateGeneration(context);
    await main.commit(async (tx) => {
      await tx.doc(Generations, main.id, String(generation), { parent, count: index.viewCount });
    }, context);
    parents.set(generation, { parent, count: index.viewCount });
    const total = index.viewCount;
    for (let id = maintenance.settled; id < total; id++)
      await repairLegacyNoise(id, generation, total, context);
    await exclusive(async () => {
      await main.commit(async (tx) => {
        const draft = await tx.doc(Index, main.id);
        if ((draft.generation ?? 0) !== parent)
          throw new Error("Memory generation changed during cleanup");
        draft.generation = generation;
        const checkpoint = await tx.doc(Maintenance, main.id);
        checkpoint.generation = generation;
        checkpoint.settled = total;
      }, context);
      index.generation = generation;
      maintenance = { generation, settled: total };
      await refreshOverview(context);
    });
  }
  async function repairLegacyNoise(
    id: number,
    generation: number,
    total: number,
    context: Context,
  ) {
    const leaf = await leafAt(id, context);
    if (!isMemoryNoise(leaf)) return;
    for (let count = 1; count <= total; count *= 2) {
      const part = { start: Math.floor(id / count) * count, count };
      const existing = await nodeAt(part, context, generation);
      if (existing === undefined) continue;
      let text = "";
      if (count > 1) {
        const left = (await nodeAt({ start: part.start, count: count / 2 }, context, generation))!;
        const right = (await nodeAt(
          { start: part.start + count / 2, count: count / 2 },
          context,
          generation,
        ))!;
        text = !left ? right : !right ? left : stripNoiseClauses(existing);
        if (!text && (left || right)) text = [left, right].filter(Boolean).join("; ");
      }
      if (text === existing) continue;
      await main.commit(async (tx) => {
        (await tx.doc(Nodes, main.id, storedKey(part, generation), { text })).text = text;
      }, context);
      cache.set(`${Nodes.definition.kind}:${storedKey(part, generation)}`, { text });
      await releaseTrackers();
    }
  }
  async function buildRange(
    start: number,
    end: number,
    count: number,
    context: Context,
    generation: number,
    operation: MemoryCall["operation"],
    repairs?: Set<string>,
  ) {
    if (start + count > end) return;
    const pipeline = withCancel(context);
    let next = start;
    let failure: unknown;
    try {
      const workers = Array.from({ length: 7 }, async () => {
        try {
          for (;;) {
            pipeline.context.abortSignal?.throwIfAborted();
            const id = next;
            next += count;
            if (id + count > end) return;
            await build(
              { start: id, count },
              pipeline.context,
              generation,
              operation,
              repairs?.has(key({ start: id, count })),
            );
            if (operation === "rebuild" && count === 1) {
              rebuildProgress!.completed++;
              if (isMemoryNoise(await leafAt(id, pipeline.context))) rebuildProgress!.excluded++;
            }
          }
        } catch (error) {
          failure ??= error;
          pipeline.cancel(error);
          throw error;
        }
      });
      await Promise.allSettled(workers);
      if (failure) throw failure;
    } finally {
      pipeline.cancel();
    }
  }
  async function settleNow(context: Context) {
    const total = index.count;
    // Legacy cleanup writes into a new generation, never into a run's pinned tree.
    if (maintenance.settled < index.viewCount) await cleanLegacyNoise(context);
    while (maintenance.settled < total) {
      const expected = { ...maintenance };
      const start = expected.settled;
      const end = Math.min(start + 64, total);
      const generation = expected.generation;
      await buildRange(start, end, 1, context, generation, "incremental");
      for (let count = 2; count <= end; count *= 2)
        await buildRange(
          Math.floor(start / count) * count,
          end,
          count,
          context,
          generation,
          "incremental",
        );
      const parts = index.parts.map((part) => ({ ...part }));
      for (let id = index.viewCount; id < end; id++) parts.push({ start: id, count: 1 });
      const viewCount = Math.max(index.viewCount, end);
      const batch: ViewBatch = { merging: index.merging };
      const fitted = await fitParts(parts, viewCount, context, generation, batch);
      config.onProgress?.({ completed: viewCount, total: index.count, nodes: cache.size });
      await publishPrefix(
        expected,
        { settled: end, viewCount, parts: fitted, merging: batch.merging },
        context,
      );
    }
  }
  const reportRebuild = (error: unknown) => {
    if (background.context.abortSignal?.aborted) return;
    rebuildError = String(error);
    (config.onError ?? ((failure: unknown) => console.error("OptChat rebuild:", failure)))(error);
  };
  async function rebuildAll() {
    const context = background.context;
    const job = await exclusive(async () => {
      await load(context);
      await syncTo(Number.MAX_SAFE_INTEGER, context);
      const existing = await harness.snapshot(Rebuild, main.id, context);
      if (existing) return existing.status === "pending" ? structuredClone(existing) : undefined;
      const candidate: MemoryRebuild = {
        generation: await allocateGeneration(context),
        baseGeneration: index.generation ?? 0,
        total: index.count,
        status: "pending",
      };
      if (config.noiseBackupDir) {
        await mkdir(config.noiseBackupDir, { recursive: true, mode: 0o700 });
        await chmod(config.noiseBackupDir, 0o700);
        await writeFile(
          path.join(config.noiseBackupDir, `rebuild-${main.id}-${Date.now()}.json`),
          JSON.stringify({ index }),
          { mode: 0o600, flag: "wx" },
        );
      }
      let excluded = 0,
        longLeaves = 0;
      for (let id = 0; id < candidate.total; id++) {
        const leaf = await leafAt(id, context);
        if (isMemoryNoise(leaf)) excluded++;
        else if (utf8Bytes(`${leaf.kind}: ${leaf.text}`) > nodeBytes) longLeaves++;
      }
      console.log("OptChat full rebuild dry-run:", {
        total: candidate.total,
        excluded,
        longLeaves,
        modelCallsUpperBound: longLeaves + candidate.total - 1,
        generation: candidate.generation,
      });
      await main.commit(
        async (tx) => Object.assign(await tx.doc(Rebuild, main.id), candidate),
        context,
      );
      return candidate;
    });
    if (!job) return;
    rebuildError = undefined;
    rebuildProgress = {
      generation: job.generation,
      total: job.total,
      completed: 0,
      excluded: 0,
    };
    // Honor already-persisted repairs, including ancestors of previously replaced
    // children. Size alone is not corruption: shortest complete candidates may
    // exceed the target and must be reused on resume.
    const repairs = new Set(job.repairs ?? []);
    // Scan all levels on resume; valid durable nodes are reused, while missing
    // nodes and the persisted repair closure are rebuilt bottom-up.
    for (let count = 1; count <= job.total; count *= 2) {
      await buildRange(0, job.total, count, context, job.generation, "rebuild", repairs);
      await main.commit(async (tx) => {
        (await tx.doc(Rebuild, main.id)).level = count * 2;
      }, context);
    }
    // Validate every node, not just the overview, before atomic publication.
    for (let count = 1; count <= job.total; count *= 2) {
      for (let start = 0; start + count <= job.total; start += count) {
        await childText({ start, count }, context, job.generation);
      }
    }
    let parts: Part[] = [];
    const batch: ViewBatch = {};
    for (let start = 0; start < job.total; start++) {
      parts.push({ start, count: 1 });
      parts = await fitParts(parts, start + 1, context, job.generation, batch);
    }
    await exclusive(async () => {
      await main.commit(async (tx) => {
        const draft = await tx.doc(Index, main.id);
        if ((draft.generation ?? 0) !== (job.baseGeneration ?? job.generation - 1))
          throw new Error("Memory generation changed during rebuild");
        draft.generation = job.generation;
        draft.viewCount = job.total;
        draft.parts = parts;
        draft.merging = batch.merging;
        (await tx.doc(Rebuild, main.id)).status = "complete";
        Object.assign(await tx.doc(Maintenance, main.id), {
          generation: job.generation,
          settled: job.total,
        });
      }, context);
      index.generation = job.generation;
      index.viewCount = job.total;
      index.parts = parts;
      index.merging = batch.merging;
      maintenance = { generation: job.generation, settled: job.total };
      await refreshOverview(context);
      console.log("OptChat full rebuild activated:", rebuildProgress);
      // Include messages admitted while the isolated generation was building.
      await syncTo(Number.MAX_SAFE_INTEGER, context);
    });
    await settleNow(context);
  }
  const sync = (context = BACKGROUND_CONTEXT) =>
    exclusive(async () => {
      await syncTo(Number.MAX_SAFE_INTEGER, context);
    });
  const settle = (context = BACKGROUND_CONTEXT) =>
    writeExclusive(async () => {
      await exclusive(() => load(context));
      await settleNow(context);
      return renderView(overviewParts, overviewNodes);
    });
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
      id + count > index.count
    )
      throw new Error(`No line ${id}+${count}`);
    if (count === 1) {
      const leaf = await leafAt(id, context);
      return `${id}+0|${leaf.kind}: ${leaf.text}`;
    }
    if (snapshot && id + count > snapshot.prepared)
      throw new Error(`No prepared line ${id}+${count} in this memory snapshot`);
    const generation = snapshot?.generation ?? index.generation ?? 0;
    const children = [
      { start: id, count: count / 2 },
      { start: id + count / 2, count: count / 2 },
    ].map(
      async (part) =>
        `${key(part)}|${(await nodeAt(part, context, generation)) ?? "(not summarized yet: zoom it)"}`,
    );
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
    const record = await storage.entry(main.id, leaf.source as EntryId, context);
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
    if (!Number.isSafeInteger(id) || id < 0 || id >= index.count)
      throw new Error(`No message ${id}`);
    const leaf = await leafAt(id, context);
    return leaf.date;
  }
  async function captureView(maximum: number, context: Context) {
    await syncTo(maximum, context);
    return captureMemorySnapshot(
      {
        count: index.count,
        prepared: index.viewCount,
        generation: overviewGeneration,
        parts: overviewParts,
        leaf: leafAt,
        node: childText,
      },
      maximum,
      budget,
      context,
    );
  }
  async function conversationalView(maximum: number, context: Context) {
    let captured = await exclusive(() => captureView(maximum, context));
    if (captured.overflow) {
      // Only an oversized raw backlog needs to wait for compression.
      await awaitWithContext(settle(context), context);
      captured = await exclusive(() => captureView(maximum, context));
    }
    return { view: snapshotView(captured.view, captured.snapshot), snapshot: captured.snapshot };
  }
  const compress = createMemoryCompressor(config, models, recordMemoryCall, report);
  const requests = createMemoryRequests({
    main: () => main,
    harness: () => harness,
    rootSessionId: () => rootSessionId,
    assistantWorkspaceId: async () => config.getAssistantWorkspaceId?.(),
    load,
    conversationalView,
    preparedView: () => ({
      view: snapshotView(renderView(overviewParts, overviewNodes), {
        generation: overviewGeneration,
        count: index.viewCount,
        prepared: index.viewCount,
      }),
      snapshot: {
        generation: overviewGeneration,
        count: index.viewCount,
        prepared: index.viewCount,
      },
    }),
    zoom: zoomOutput,
    date,
    search,
    report,
  });
  return {
    extension: requests.extension,
    validateRequest: requests.validateRequest,
    async bind(
      open: Harness,
      root: Conversation,
      treeStorage: Storage,
      searchStorage?: MemorySearch,
    ) {
      searchIndex = searchStorage;
      storage = treeStorage;
      harness = open;
      main = root;
      rootSessionId = (await harness.snapshot(ProviderDoc, main.id, BACKGROUND_CONTEXT))!.sessionId;
      await load(BACKGROUND_CONTEXT);
      const bootstrap =
        (await main.entries({}, 1, undefined, BACKGROUND_CONTEXT)).items[0]?.id ?? 0;
      const active = await harness.snapshot(LiveDoc, main.id, BACKGROUND_CONTEXT);
      const input = active?.run?.inputs[0];
      const submission = input
        ? await (await harness.submission(input, BACKGROUND_CONTEXT))!.status(BACKGROUND_CONTEXT)
        : undefined;
      const cutoff = submission?.entry ? submission.entry - 1 : bootstrap;
      const start = (maximum: number) => {
        void writeExclusive(async () => {
          await exclusive(async () => {
            await syncTo(maximum, background.context);
            await indexSearch(background.context);
          });
          await settleNow(background.context);
        }).catch((error) => {
          if (!background.context.abortSignal?.aborted) report(error);
        });
      };
      unsubscribe = harness.subscribeCommits((publication) => {
        for (const change of publication.changes) {
          if (change.type !== "document" || change.conversationId !== main.id || !change.record.key)
            continue;
          if (
            change.record.kind === Leaves.definition.kind ||
            change.record.kind === Nodes.definition.kind
          ) {
            const name = `${change.record.kind}:${change.record.key}`;
            if (change.value)
              cache.set(name, structuredClone(change.value) as MemoryLeaf | { text: string });
            else cache.delete(name);
          }
        }
        const finished = publication.changes.filter(
          (change) =>
            change.type === "entry" &&
            change.value.conversationId === main.id &&
            change.value.model?.some(
              (message) =>
                message.role === "assistant" &&
                (message.stopReason === "stop" || message.stopReason === "length"),
            ),
        );
        if (finished.length) {
          const maximum = Math.max(
            ...finished.map((change) => (change as { value: EntryRecord }).value.id),
          );
          queueMicrotask(() => start(maximum));
        }
      });
      unsubscribeClose = harness.subscribeClose(() => background.cancel());
      start(cutoff);
      if (config.rebuildRequested) {
        rebuilding = writeExclusive(rebuildAll)
          .finally(() => {
            rebuilding = undefined;
          })
          .catch(reportRebuild);
      }
    },
    async browserOverview() {
      const parts = overviewParts;
      const generation = overviewGeneration;
      return {
        nodes: await Promise.all(parts.map((part) => browserSummary(part, generation))),
        prepared: parts.reduce((total, part) => total + part.count, 0),
        total: index.count,
      };
    },
    async browserNode(id: number, count: number) {
      if (
        !Number.isSafeInteger(id) ||
        !Number.isSafeInteger(count) ||
        count < 1 ||
        Math.log2(count) % 1 !== 0 ||
        id < 0 ||
        id % count !== 0 ||
        id + count > index.viewCount
      )
        throw new RangeError(`No prepared line ${id}+${count}`);
      const generation = index.generation ?? 0;
      if (count === 1) return { children: [], text: await zoom(id, count) };
      return {
        children: [
          await browserSummary({ start: id, count: count / 2 }, generation),
          await browserSummary({ start: id + count / 2, count: count / 2 }, generation),
        ],
      };
    },
    search,
    async repair(roots: Part[], generation: number, dryRun = false) {
      return writeExclusive(async () => {
        const context = background.context;
        await exclusive(() => load(context));
        if (generation !== (index.generation ?? 0))
          throw new RangeError("Active memory generation changed");
        if (rebuilding) throw new Error("Cannot repair during a full rebuild");
        if (!roots.length) throw new RangeError("At least one repair root is required");
        const selected = new Map<string, Part>();
        for (const root of roots) {
          if (
            !Number.isSafeInteger(root.start) ||
            !Number.isSafeInteger(root.count) ||
            root.count < 1 ||
            Math.log2(root.count) % 1 !== 0 ||
            root.start < 0 ||
            root.start % root.count !== 0 ||
            root.start + root.count > index.viewCount
          )
            throw new RangeError(`Invalid repair root ${key(root)}`);
          await childText(root, context, generation);
          for (let count = root.count; count <= index.viewCount; count *= 2) {
            const part = { start: Math.floor(root.start / count) * count, count };
            if ((await nodeAt(part, context, generation)) !== undefined)
              selected.set(key(part), part);
          }
        }
        const parts = [...selected.values()].sort((a, b) => a.count - b.count || a.start - b.start);
        if (dryRun) return { generation, nodes: parts.map((part) => ({ ...part })) };
        // The writer queue serializes repairs and maintenance, not model requests.
        // Publish repaired nodes in a child generation; pinned runs keep the old tree.
        const staged = new Map<string, string>();
        const previous = new Map<string, string>();
        for (const part of parts) {
          previous.set(key(part), await childText(part, context, generation));
          const child = async (start: number) => {
            const childPart = { start, count: part.count / 2 };
            return staged.get(key(childPart)) ?? childText(childPart, context, generation);
          };
          const leaf = part.count === 1 ? await leafAt(part.start, context) : undefined;
          const source = leaf
            ? isMemoryNoise(leaf)
              ? ""
              : `${leaf.kind}: ${leaf.text}`
            : [await child(part.start), await child(part.start + part.count / 2)]
                .filter(Boolean)
                .join("\n");
          staged.set(
            key(part),
            await compress(
              source.trim(),
              context,
              { ...part, generation, operation: "incremental" },
              true,
            ),
          );
        }
        const nextGeneration = await allocateGeneration(context);
        await exclusive(async () => {
          await main.commit(async (tx) => {
            const draft = await tx.doc(Index, main.id);
            if ((draft.generation ?? 0) !== generation)
              throw new Error("Memory generation changed during repair");
            for (const part of parts) {
              if ((await childText(part, context, generation)) !== previous.get(key(part)))
                throw new Error(`Memory node changed during repair: ${key(part)}`);
              await tx.doc(Nodes, main.id, storedKey(part, nextGeneration), {
                text: staged.get(key(part))!,
              });
            }
            await tx.doc(Generations, main.id, String(nextGeneration), {
              parent: generation,
              count: index.viewCount,
            });
            draft.generation = nextGeneration;
            (await tx.doc(Maintenance, main.id)).generation = nextGeneration;
          }, context);
          parents.set(nextGeneration, { parent: generation, count: index.viewCount });
          index.generation = nextGeneration;
          maintenance.generation = nextGeneration;
          await refreshOverview(context);
          await releaseTrackers(true);
        });
        return {
          generation: nextGeneration,
          nodes: parts.map((part) => ({ ...part, text: staged.get(key(part))! })),
        };
      });
    },
    async usage() {
      return {
        ...((await harness.snapshot(MemoryUsageDoc, main.id, BACKGROUND_CONTEXT)) ?? {
          incremental: emptyMemoryUsage(),
          rebuild: emptyMemoryUsage(),
          since: null,
        }),
        costBasis: "API-equivalent catalog estimate, not subscription spending",
        coverage:
          "Since instrumentation; provider-internal retries without returned usage are unknown",
      };
    },
    status() {
      const totalLeaves = index?.count ?? 0;
      const builtLeaves = index?.viewCount ?? 0;
      return {
        totalLeaves,
        builtLeaves,
        pending: totalLeaves - builtLeaves,
        settled: maintenance?.settled ?? 0,
        cacheBytes: cache.bytes,
        cacheEntries: cache.size,
        error: lastError,
        ...(rebuildProgress ? { rebuild: { ...rebuildProgress, error: rebuildError } } : {}),
      };
    },
    close: async () => {
      unsubscribe();
      unsubscribeClose();
      background.cancel();
      await rebuilding;
      await writer;
      await serial;
    },
    async rebuild() {
      rebuilding ??= writeExclusive(rebuildAll)
        .catch((error) => {
          reportRebuild(error);
          throw error;
        })
        .finally(() => {
          rebuilding = undefined;
        });
      return rebuilding;
    },
    sync,
    settle,
    prepare: async (context = BACKGROUND_CONTEXT) => {
      await sync(context);
      return settle(context);
    },
    zoom,
    date,
  };
}
