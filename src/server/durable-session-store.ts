import fs from "node:fs/promises";
import lockfile from "proper-lockfile";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import { convertToLlm, type SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  Harness,
  type Conversation,
  type Cursor,
  type EntryDraft,
  type EntryRecord,
  type HarnessOptions,
  type Storage,
  type Tx,
} from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import type { Message } from "@earendil-works/pi-ai";
import type { SessionStore } from "./session-store";

const context = BACKGROUND_CONTEXT;
export const DURABLE_ENTRY_CUSTOM_TYPE = "batty.durable-entry";
const MESSAGE_ID = "battyDurableEntryId";

type ImportData = { legacyEntry: SessionEntry; legacyEntryId: string };
type DurableCustomMessage = {
  customType: string;
  content: Extract<SessionEntry, { type: "custom_message" }>["content"];
  display: boolean;
  details?: unknown;
  timestamp: number;
};

/** Overlay committed side-effect receipts on presentation copies, never native/model state. */
export function decorateDurableArtifacts(
  entries: SessionEntry[],
  receipts: SessionEntry[] = entries,
): SessionEntry[] {
  const artifacts = new Map<number, Record<string, JsonValue>>();
  for (const entry of receipts) {
    if (entry.type !== "custom" || entry.customType !== "batty.tool-artifacts") continue;
    const data = entry.data as { toolTaskId?: number; details?: unknown } | undefined;
    if (
      typeof data?.toolTaskId !== "number" ||
      !data.details ||
      typeof data.details !== "object" ||
      Array.isArray(data.details)
    )
      continue;
    // These payloads are copied from committed JSON records, so their object
    // values satisfy the same JSON contract as model-facing tool result details.
    artifacts.set(data.toolTaskId, data.details as Record<string, JsonValue>);
  }
  return entries.map((entry) => {
    if (entry.type !== "message" || entry.message.role !== "toolResult") return entry;
    const taskId = (entry.message as typeof entry.message & { battyDurableTaskId?: number })
      .battyDurableTaskId;
    const details = taskId === undefined ? undefined : artifacts.get(taskId);
    if (!details) return entry;
    const previous =
      entry.message.details &&
      typeof entry.message.details === "object" &&
      !Array.isArray(entry.message.details)
        ? entry.message.details
        : {};
    return { ...entry, message: { ...entry.message, details: { ...previous, ...details } } };
  });
}

function projectionDetails(details: unknown, record: EntryRecord) {
  return {
    ...(details && typeof details === "object" && !Array.isArray(details)
      ? details
      : details === undefined
        ? {}
        : { details }),
    durableEntryId: String(record.id),
    durableModel: record.model ?? [],
  };
}

// Session entries already crossed a JSON persistence boundary. Round-tripping also
// strips optional undefined fields before handing their payload to Chord.
function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
function imported(record: EntryRecord): ImportData | undefined {
  const data = record.data;
  if (data && typeof data === "object" && !Array.isArray(data) && "legacyEntryId" in data)
    return data as unknown as ImportData;
  return undefined;
}
function projectedId(entry: SessionEntry): string | undefined {
  if (entry.type === "message") {
    const message = entry.message as typeof entry.message & { battyDurableEntryId?: string };
    return message.battyDurableEntryId;
  }
  const data =
    entry.type === "compaction" ||
    entry.type === "custom_message" ||
    entry.type === "branch_summary"
      ? entry.details
      : entry.type === "custom"
        ? entry.data
        : undefined;
  if (data && typeof data === "object" && "durableEntryId" in data)
    return String(data.durableEntryId);
  return undefined;
}
function contribution(entry: SessionEntry): Message[] {
  if (
    entry.type === "custom_message" &&
    entry.details &&
    typeof entry.details === "object" &&
    "durableModel" in entry.details &&
    Array.isArray(entry.details.durableModel)
  ) {
    // A display-only durable custom write must stay display-only when its UI
    // projection becomes the bootstrap source of a newly forked session.
    return entry.details.durableModel as Message[];
  }
  if (entry.type === "message") return convertToLlm([entry.message]);
  const timestamp = Date.parse(entry.timestamp);
  if (entry.type === "custom_message")
    return convertToLlm([
      {
        role: "custom",
        customType: entry.customType,
        content: entry.content,
        display: entry.display,
        details: entry.details,
        timestamp,
      },
    ]);
  if (entry.type === "branch_summary")
    return convertToLlm([
      { role: "branchSummary", summary: entry.summary, fromId: entry.fromId, timestamp },
    ]);
  if (entry.type === "compaction")
    return convertToLlm([
      {
        role: "compactionSummary",
        summary: entry.summary,
        tokensBefore: entry.tokensBefore,
        timestamp,
      },
    ]);
  return [];
}

async function importEntries(
  tx: Tx,
  conversationId: Conversation["id"],
  entries: SessionEntry[],
  known: Map<string, EntryRecord>,
  bootstrap = false,
) {
  // Resolve every table read before writes: durable transactions forbid read-after-write.
  for (const entry of entries) {
    if (
      known.has(entry.id) ||
      (!bootstrap && projectedId(entry)) ||
      (entry.type === "custom" && entry.customType === DURABLE_ENTRY_CUSTOM_TYPE)
    )
      continue;
    const model = contribution(entry);
    const draft: { -readonly [K in keyof EntryDraft]: EntryDraft[K] } = {
      kind:
        entry.type === "message" && model.length
          ? {
              user: "pi.user",
              assistant: "pi.assistant",
              toolResult: "pi.tool-result",
              system: "pi.system",
            }[model[0]!.role]
          : `batty.legacy.${entry.type}`,
      data: json({ legacyEntryId: entry.id, legacyEntry: entry }),
      ...(model.length ? { model } : {}),
    };
    if (entry.type === "compaction") {
      const kept = known.get(entry.firstKeptEntryId);
      if (!kept && entry.firstKeptEntryId !== entry.id)
        throw new Error(`Missing legacy compaction target ${entry.firstKeptEntryId}`);
      draft.kind = "pi.compaction";
      draft.head = kept?.id ?? "self";
    }
    if (entry.type === "context_edit") {
      const target = known.get(entry.targetId);
      if (!target) throw new Error(`Missing legacy context edit target ${entry.targetId}`);
      draft.edits =
        entry.replacement === null
          ? [{ target: target.id, action: "omit" }]
          : [
              {
                target: target.id,
                action: "replace",
                messages: (target.model ?? []).map(
                  (message) =>
                    // Legacy context edits replace only content and preserve each message's role.
                    ({ ...message, content: entry.replacement!.content }) as Message,
                ),
              },
            ];
    }
    known.set(entry.id, await tx.appendEntry(conversationId, draft));
  }
}

async function history(conversation: Conversation): Promise<EntryRecord[]> {
  const records: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await conversation.entries({}, 500, cursor, context);
    records.push(...page.items);
    cursor = page.next;
  } while (cursor);
  return records.reverse();
}

/** The sidecar is authoritative; the original JSONL is only a web/UI projection. */
export async function openDurableSession(store: SessionStore, options: HarnessOptions) {
  const directory = `${store.getSessionFile()}.durable`;
  await fs.mkdir(directory, { recursive: true });
  // JSONL has no writer lock. Hold one across the entire Harness lifetime.
  const release = await lockfile.lock(directory, { realpath: false });
  let harness: Harness;
  let storage: Storage;
  try {
    storage = await openNodeJsonlStorage(directory, context, { fsync: true });
    try {
      harness = await Harness.open(storage, options, context);
    } catch (error) {
      await storage.close(context);
      throw error;
    }
  } catch (error) {
    await release();
    throw error;
  }
  try {
    // The root's initialization is atomic with its creation and runs exactly once.
    const conversation = await harness.root(context, {
      init: async (tx, id) => {
        await importEntries(tx, id, store.getBranch(), new Map(), true);
      },
    });
    const records = await history(conversation);
    const legacy = new Map(
      records.flatMap((record) => {
        const data = imported(record);
        return data ? [[data.legacyEntryId, record] as const] : [];
      }),
    );
    const mapped = new Map<string, string>();
    for (const entry of store.getEntries()) {
      // An ancestor sidecar's numeric IDs are not identities in a fork's sidecar.
      const source = legacy.get(entry.id);
      if (source) mapped.set(String(source.id), entry.id);
      else {
        const id = projectedId(entry);
        if (id) {
          const target =
            entry.type === "custom" && entry.customType === DURABLE_ENTRY_CUSTOM_TYPE
              ? (entry.data as { sessionEntryId?: string }).sessionEntryId
              : undefined;
          if (!target || store.native.getEntry(target)) mapped.set(id, target ?? entry.id);
        }
      }
    }

    function projectedLegacyTarget(legacyId: string): string {
      const record = legacy.get(legacyId);
      const target = record && mapped.get(String(record.id));
      if (!target) throw new Error(`Unprojected legacy target ${legacyId}`);
      return target;
    }

    function projectLegacyEntry(record: EntryRecord, entry: SessionEntry): string {
      const key = String(record.id);
      switch (entry.type) {
        case "message": {
          // SessionEntry's union also admits summary roles, while appendMessage
          // deliberately excludes them. Their persisted projection is a user message.
          const source =
            entry.message.role === "branchSummary" || entry.message.role === "compactionSummary"
              ? contribution(entry)[0]!
              : entry.message;
          const message = { ...source, [MESSAGE_ID]: key };
          return store.native.appendMessage(message);
        }
        case "custom_message":
          return store.native.appendCustomMessageEntry(
            entry.customType,
            entry.content,
            entry.display,
            projectionDetails(entry.details, record),
          );
        case "compaction":
          return store.native.appendCompaction(
            entry.summary,
            entry.firstKeptEntryId === entry.id
              ? null
              : projectedLegacyTarget(entry.firstKeptEntryId),
            entry.tokensBefore,
            projectionDetails(entry.details, record),
            entry.fromHook,
            entry.usage,
          );
        case "branch_summary":
          return store.native.branchWithSummary(
            store.getLeafId(),
            entry.summary,
            projectionDetails(entry.details, record),
            entry.fromHook,
            entry.usage,
          );
      }
      let id: string;
      switch (entry.type) {
        case "custom":
          id = store.native.appendCustomEntry(entry.customType, entry.data);
          break;
        case "model_change":
          id = store.native.appendModelChange(entry.provider, entry.modelId);
          break;
        case "thinking_level_change":
          id = store.native.appendThinkingLevelChange(entry.thinkingLevel);
          break;
        case "session_info":
          id = store.native.appendSessionInfo(entry.name ?? "");
          break;
        case "usage":
          id = store.native.appendUsage(
            entry.kind,
            entry.provider,
            entry.model,
            entry.usage,
            entry.note,
          ).id;
          break;
        case "label":
          id = store.native.appendLabelChange(projectedLegacyTarget(entry.targetId), entry.label);
          break;
        case "context_edit":
          id = store.native.appendContextEdit(
            projectedLegacyTarget(entry.targetId),
            entry.replacement,
          );
          break;
      }
      // The SDK does not accept metadata on state-only entries. Persist their
      // mapping separately; model messages/custom messages carry atomic identity.
      store.native.appendCustomEntry(DURABLE_ENTRY_CUSTOM_TYPE, {
        durableEntryId: key,
        sessionEntryId: id,
      });
      return id;
    }

    async function projectCommittedEntries(entries: readonly EntryRecord[]): Promise<void> {
      let changed = false;
      for (const record of [...entries].sort((a, b) => a.id - b.id)) {
        if (record.conversationId !== conversation.id) continue;
        if (mapped.has(String(record.id)) && (record.model?.length ?? 0) <= 1) continue;
        const data = imported(record);
        if (data) {
          const source = store.native.getEntry(data.legacyEntryId);
          if (source) {
            mapped.set(String(record.id), source.id);
            continue;
          }
          // Missing imports are repaired from durable data, never from old model context.
          const id = projectLegacyEntry(record, data.legacyEntry);
          mapped.set(String(record.id), id);
          changed = true;
          continue;
        }
        if (record.kind === "batty.custom-message") {
          // The host owns this entry schema; its data remains a display payload,
          // distinct from the optional messages in durable model context.
          const custom = record.data as unknown as DurableCustomMessage;
          const id = store.native.appendCustomMessageEntry(
            custom.customType,
            custom.content,
            custom.display,
            projectionDetails(custom.details, record),
          );
          mapped.set(String(record.id), id);
          changed = true;
        } else if (record.kind === "batty.tool-artifacts") {
          const payload =
            record.data && typeof record.data === "object" && !Array.isArray(record.data)
              ? record.data
              : {};
          const id = store.native.appendCustomEntry("batty.tool-artifacts", {
            ...payload,
            durableEntryId: String(record.id),
          });
          mapped.set(String(record.id), id);
          changed = true;
        } else if (record.kind === "pi.compaction") {
          const summary = record.model?.find((message) => message.role === "user");
          const text =
            typeof summary?.content === "string"
              ? summary.content
              : (summary?.content
                  .filter((block) => block.type === "text")
                  .map((block) => block.text)
                  .join("\n") ?? "");
          const kept =
            record.head === record.id ? null : record.head && mapped.get(String(record.head));
          if (kept === undefined)
            throw new Error(`Unprojected durable compaction head ${record.head}`);
          const id = store.native.appendCompaction(text, kept, 0, {
            durableEntryId: String(record.id),
          });
          mapped.set(String(record.id), id);
          changed = true;
        } else if (
          ["pi.user", "pi.system", "pi.assistant", "pi.tool-result"].includes(record.kind)
        ) {
          let clientMessageId: string | undefined;
          let customInput:
            | Pick<DurableCustomMessage, "customType" | "display" | "details">
            | undefined;
          if (record.kind === "pi.user") {
            let cursor: Cursor | undefined;
            do {
              const page = await storage.scanSubmissions(
                { conversationId: conversation.id },
                500,
                cursor,
                context,
              );
              const submission = page.items.find((item) => item.entry === record.id);
              if (submission?.requestId?.startsWith("client:"))
                clientMessageId = submission.requestId.slice(7);
              if (submission?.requestId?.startsWith("custom-input:")) {
                // Host admission stores display metadata inside its deduplication key
                // atomically with the input; it creates no second custom/model entry.
                customInput = JSON.parse(
                  Buffer.from(submission.requestId.split(":")[1]!, "base64url").toString("utf8"),
                );
              }
              cursor = submission ? undefined : page.next;
            } while (cursor);
          }
          for (let index = 0; index < (record.model?.length ?? 0); index++) {
            const key = index === 0 ? String(record.id) : `${record.id}:${index}`;
            if (mapped.has(key)) continue;
            let message = record.model![index]!;
            if (message.role === "toolResult") {
              // Durable task identity binds even late receipts to this exact tool
              // execution. Provider call IDs can repeat across different runs.
              const artifact = (await history(conversation)).findLast(
                (entry) =>
                  record.byTaskId !== undefined &&
                  entry.kind === "batty.tool-artifacts" &&
                  entry.data &&
                  typeof entry.data === "object" &&
                  !Array.isArray(entry.data) &&
                  entry.data.toolTaskId === record.byTaskId,
              );
              const details =
                artifact?.data && typeof artifact.data === "object" && !Array.isArray(artifact.data)
                  ? artifact.data.details
                  : undefined;
              if (details && typeof details === "object" && !Array.isArray(details)) {
                const previous =
                  message.details &&
                  typeof message.details === "object" &&
                  !Array.isArray(message.details)
                    ? message.details
                    : {};
                message = { ...message, details: { ...previous, ...details } };
              }
            }
            const payload =
              record.data && typeof record.data === "object" && !Array.isArray(record.data)
                ? record.data
                : {};
            // Pi persists unknown message properties. Identity and content share one
            // JSONL record, eliminating the message/marker crash window.
            const projected = {
              ...message,
              [MESSAGE_ID]: key,
              ...(message.role === "toolResult" && record.byTaskId !== undefined
                ? { battyDurableTaskId: record.byTaskId }
                : {}),
              ...(clientMessageId
                ? { clientMessageId }
                : typeof payload.clientMessageId === "string"
                  ? { clientMessageId: payload.clientMessageId }
                  : {}),
            };
            const id =
              customInput && message.role === "user"
                ? store.native.appendCustomMessageEntry(
                    customInput.customType,
                    message.content,
                    customInput.display,
                    { ...projectionDetails(customInput.details, record), durableEntryId: key },
                  )
                : store.native.appendMessage(projected);
            mapped.set(key, id);
            changed = true;
          }
        }
      }
      if (changed) store.publishSummary();
    }

    let projection: Promise<void> = Promise.resolve();
    function projectEntries(entries: readonly EntryRecord[]): Promise<void> {
      const next = projection.then(
        () => projectCommittedEntries(entries),
        () => projectCommittedEntries(entries),
      );
      projection = next;
      return next;
    }

    async function syncHostEntries(): Promise<void> {
      await conversation.commit(async (tx) => {
        // Refresh inside the mutation line so concurrent sync calls cannot duplicate imports.
        const all: EntryRecord[] = [];
        let cursor: Cursor | undefined;
        do {
          const page = await tx.scanEntries({ conversationId: conversation.id }, 500, cursor);
          all.push(...page.items);
          cursor = page.next;
        } while (cursor);
        const known = new Map(
          all.flatMap((record) => {
            const data = imported(record);
            return data ? [[data.legacyEntryId, record] as const] : [];
          }),
        );
        const byId = new Map(all.map((record) => [String(record.id), record]));
        for (const [id, presentationId] of mapped) {
          const record = byId.get(id.split(":")[0]!);
          if (record && !known.has(presentationId)) known.set(presentationId, record);
        }
        for (const entry of store.getBranch()) {
          const id = projectedId(entry);
          const record = id && byId.get(id.split(":")[0]!);
          if (record && !known.has(entry.id)) known.set(entry.id, record);
        }
        await importEntries(tx, conversation.id, store.getBranch(), known);
      }, context);
    }
    // Repair commits that reached the sidecar before the prior process could mirror them.
    await projectEntries(records);
    let closed = false;
    return {
      harness,
      conversation,
      projectEntries,
      syncHostEntries,
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        try {
          await projection;
        } finally {
          try {
            await harness.close(context);
          } finally {
            await release();
          }
        }
      },
    };
  } catch (error) {
    try {
      await harness.close(context);
    } finally {
      await release();
    }
    throw error;
  }
}
