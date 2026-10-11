import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
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
import {
  Leaves,
  Rebuild,
  MemoryIndexDoc as Index,
  MemoryMaintenanceDoc as Maintenance,
  MemoryNodesDoc as Nodes,
  type MemoryIndex,
  type MemoryRebuild,
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
  let checkpointDirty = false;
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
  const nodeAt = async (part: Part, context: Context, generation = index.generation ?? 0) =>
    (await readTree<{ text: string }>(Nodes.definition.kind, storedKey(part, generation), context))
      ?.text;
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
  async function saveMaintenance(context: Context) {
    await main.commit(async (tx) => {
      Object.assign(await tx.doc(Maintenance, main.id), maintenance);
      const draft = await tx.doc(Index, main.id);
      draft.viewCount = index.viewCount;
      draft.parts = index.parts;
      draft.merging = index.merging;
    }, context);
    await refreshOverview(context);
    await releaseTrackers(true);
    checkpointDirty = false;
  }
  async function repairLegacyNoise(id: number, context: Context) {
    const leaf = await leafAt(id, context);
    if (!isMemoryNoise(leaf)) return;
    for (let count = 1; count <= index.count; count *= 2) {
      const part = { start: Math.floor(id / count) * count, count };
      const existing = await nodeAt(part, context);
      if (existing === undefined) continue;
      let text = "";
      if (count > 1) {
        const left = (await nodeAt({ start: part.start, count: count / 2 }, context))!;
        const right = (await nodeAt({ start: part.start + count / 2, count: count / 2 }, context))!;
        text = !left ? right : !right ? left : stripNoiseClauses(existing);
        if (!text && (left || right)) text = [left, right].filter(Boolean).join("; ");
      }
      if (text === existing) continue;
      await main.commit(async (tx) => {
        (await tx.doc(Nodes, main.id, storedKey(part), { text })).text = text;
      }, context);
      cache.set(`${Nodes.definition.kind}:${storedKey(part)}`, { text });
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
    if (maintenance.settled === index.count) {
      if (checkpointDirty) await saveMaintenance(context);
      return;
    }
    // A bounded prefix is published only after its leaves and every newly
    // completed ancestor are durable. Retry reuses committed children.
    while (maintenance.settled < index.count) {
      const start = maintenance.settled;
      const end = Math.min(start + 64, index.count);
      const generation = index.generation ?? 0;
      for (let id = start; id < Math.min(end, index.viewCount); id++)
        await repairLegacyNoise(id, context);
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
      for (let id = index.viewCount; id < end; id++) index.parts.push({ start: id, count: 1 });
      index.viewCount = Math.max(index.viewCount, end);
      index.parts = await fitParts(index.parts, index.viewCount, context);
      maintenance.settled = end;
      checkpointDirty = true;
      config.onProgress?.({ completed: index.viewCount, total: index.count, nodes: cache.size });
      await saveMaintenance(context);
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
        generation: (index.generation ?? 0) + 1,
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
      // Includes messages admitted while the isolated generation was building.
      await syncTo(Number.MAX_SAFE_INTEGER, context);
      await settleNow(context);
    });
  }
  const sync = (context = BACKGROUND_CONTEXT) =>
    exclusive(async () => {
      await syncTo(Number.MAX_SAFE_INTEGER, context);
    });
  const settle = (context = BACKGROUND_CONTEXT) =>
    exclusive(async () => {
      await load(context);
      await settleNow(context);
      return renderView(overviewParts, overviewNodes);
    });
  async function zoom(id: number, count: number, context = BACKGROUND_CONTEXT) {
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
    const generation = index.generation ?? 0;
    const children = [
      { start: id, count: count / 2 },
      { start: id + count / 2, count: count / 2 },
    ].map(
      async (part) =>
        `${key(part)}|${(await nodeAt(part, context, generation)) ?? "(not summarized yet: zoom it)"}`,
    );
    return (await Promise.all(children)).join("\n");
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
  async function conversationalView(context: Context) {
    await settleNow(context);
    // Explicitly expose any unsummarized originals through aligned zoomable ranges.
    const parts = [...overviewParts];
    for (let start = index.viewCount; start < index.count;) {
      let count = 1;
      while (start % (count * 2) === 0 && start + count * 2 <= index.count) count *= 2;
      parts.push({ start, count });
      start += count;
    }
    return renderView(parts, overviewNodes);
  }
  const compress = createMemoryCompressor(config, models, recordMemoryCall, report);
  const requests = createMemoryRequests({
    main: () => main,
    harness: () => harness,
    rootSessionId: () => rootSessionId,
    exclusive,
    syncTo,
    load,
    conversationalView,
    preparedView: () => renderView(overviewParts, overviewNodes),
    zoom,
    date,
    search,
    report,
  });
  return {
    extension: requests.extension,
    contextFor: requests.contextFor,
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
        void exclusive(async () => {
          await syncTo(maximum, background.context);
          await indexSearch(background.context);
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
        rebuilding = rebuildAll()
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
      return exclusive(async () => {
        const context = background.context;
        await load(context);
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
        // Stage the entire closure before writing. The shared exclusive queue blocks
        // incremental maintenance; readers keep the coherent old overview meanwhile.
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
        await main.commit(async (tx) => {
          if (((await tx.doc(Index, main.id)).generation ?? 0) !== generation)
            throw new Error("Memory generation changed during repair");
          for (const part of parts) {
            const draft = await tx.doc(Nodes, main.id, storedKey(part, generation), { text: "" });
            if (draft.text !== previous.get(key(part)))
              throw new Error(`Memory node changed during repair: ${key(part)}`);
            draft.text = staged.get(key(part))!;
          }
        }, context);
        for (const part of parts)
          cache.set(`${Nodes.definition.kind}:${storedKey(part, generation)}`, {
            text: staged.get(key(part))!,
          });
        await refreshOverview(context);
        await releaseTrackers(true);
        return {
          generation,
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
      await serial;
    },
    async rebuild() {
      rebuilding ??= rebuildAll()
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
