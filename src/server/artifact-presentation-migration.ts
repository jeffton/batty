import type { EntryRecord } from "@earendil-works/pi-durable";
import type { SqliteDatabase, SqliteExecutor } from "@earendil-works/pi-durable/storage/sqlite";
import type { MessagePresentation } from "./message-presentation";
import {
  legacyNativeCarrier,
  legacyReplySources,
  legacyRuntimeResultArtifacts,
  mergeResponseArtifacts,
} from "./legacy-artifact-projection";
import {
  BATTY_RUNTIME_NOTICE_CUSTOM_TYPE,
  decodeRuntimeNotice,
  encodeRuntimeNotice,
} from "./runtime-notices";
import { decodeSiteAttachmentDescriptor } from "./site-attachments";

const marker = "batty_artifact_presentation_v1";
const batchSize = 64;

type Message = NonNullable<EntryRecord["model"]>[number];
type ArtifactFields = Pick<MessagePresentation, "sentFiles" | "sites" | "fileChanges">;
type LegacyData = Record<string, unknown> & {
  runtimeResultArtifacts?: ArtifactFields & { reportAttachments?: ArtifactFields };
};

interface MigrationCounts {
  replies: number;
  notices: number;
  entries: number;
  files: number;
  sites: number;
  browsers: number;
  diffs: number;
  unrecoveredNotices: number;
  terminalNativeGroups: number;
  uploadedInputs: number;
  remoteFiles: number;
  remoteNotices: number;
}

function counts(): MigrationCounts {
  return {
    replies: 0,
    notices: 0,
    entries: 0,
    files: 0,
    sites: 0,
    browsers: 0,
    diffs: 0,
    unrecoveredNotices: 0,
    terminalNativeGroups: 0,
    uploadedInputs: 0,
    remoteFiles: 0,
    remoteNotices: 0,
  };
}

async function readMarker(db: SqliteExecutor): Promise<MigrationCounts | undefined> {
  const table = await db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", marker);
  if (!table) return undefined;
  const row = await db.get<{ counts: string }>(`SELECT counts FROM ${marker} WHERE id=1`);
  return row && JSON.parse(row.counts);
}

async function hasEntries(db: SqliteExecutor) {
  return Boolean(await db.get("SELECT 1 FROM entries LIMIT 1"));
}

async function writeMarker(db: SqliteExecutor, result: MigrationCounts) {
  await db.exec(`CREATE TABLE ${marker} (
    id INTEGER PRIMARY KEY CHECK (id=1), counts TEXT NOT NULL CHECK (json_valid(counts))
  ) STRICT`);
  await db.run(`INSERT INTO ${marker} VALUES (1, ?)`, JSON.stringify(result));
}

export async function assertArtifactPresentationReady(database: SqliteDatabase) {
  if (!(await readMarker(database)) && (await hasEntries(database))) {
    throw new Error(
      "Batty artifact presentation migration required; see docs/artifact-presentation-migration.md",
    );
  }
}

export async function markNewArtifactPresentationDatabase(database: SqliteDatabase) {
  if ((await readMarker(database)) || (await hasEntries(database))) return;
  await database.transaction(async (tx) => {
    if (!(await readMarker(tx)) && !(await hasEntries(tx))) await writeMarker(tx, counts());
  });
}

function presentation(fields: ArtifactFields, totals: MigrationCounts) {
  const { sentFiles, sites, fileChanges } = fields;
  if (!sentFiles && !sites && !fileChanges) return undefined;
  const normalizedSites = sites?.map(decodeSiteAttachmentDescriptor);
  totals.files += sentFiles?.length ?? 0;
  totals.remoteFiles +=
    sentFiles?.filter(({ downloadUrl }) => downloadUrl?.includes("/api/sent-files/remote-"))
      .length ?? 0;
  totals.sites += normalizedSites?.filter(({ kind }) => kind === "site").length ?? 0;
  totals.browsers += normalizedSites?.filter(({ kind }) => kind === "browser").length ?? 0;
  totals.diffs += fileChanges?.length ?? 0;
  return { sentFiles, sites: normalizedSites, fileChanges, historical: true as const };
}

// Match the previous SQL boundary separately from the displayed response: the old
// query bounded by raw image blocks, but projection only targeted valid UI images.
type RawBlock = { type?: string; text?: string; mimeType?: string; data?: string; url?: string };
function rawBoundary(message: Message) {
  const display = (message as { display?: unknown }).display;
  if (
    message.role !== "assistant" ||
    display === false ||
    display === 0 ||
    !Array.isArray(message.content)
  )
    return false;
  return (message.content as RawBlock[]).some(
    (block) =>
      block?.type === "image" ||
      (block?.type === "text" && typeof block.text === "string" && block.text.trim() !== ""),
  );
}

function visibleResponse(content: unknown) {
  if (typeof content === "string") return content.trim() !== "";
  return (
    Array.isArray(content) &&
    (content as RawBlock[]).some(
      (block) =>
        (block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "") ||
        (block?.type === "image" &&
          typeof block.mimeType === "string" &&
          (typeof block.data === "string" || typeof block.url === "string")),
    )
  );
}

type HistoricalAssistant = {
  battyPresentation?: unknown;
  battyFileChanges?: ArtifactFields["fileChanges"];
  battySentFiles?: ArtifactFields["sentFiles"];
  battySites?: ArtifactFields["sites"];
};

function convertReplies(
  entry: EntryRecord,
  prior: ReturnType<typeof legacyReplySources> | undefined,
  native: ArtifactFields[],
  totals: MigrationCounts,
) {
  let changed = false;
  let accumulated: ArtifactFields | undefined;
  for (const message of entry.model ?? []) {
    if ((message as { display?: unknown }).display === false) continue;
    if (message.role !== "assistant") {
      const carrier = legacyNativeCarrier(message);
      if (carrier) native.push(carrier);
      continue;
    }
    const stored = message as typeof message & HistoricalAssistant;
    if (stored.battyPresentation !== undefined) continue;
    const explicit = {
      fileChanges: stored.battyFileChanges,
      sentFiles: stored.battySentFiles,
      sites: stored.battySites,
    };
    const visible = visibleResponse(message.content);
    const ownsNative = visible || Boolean(explicit.sentFiles?.length || explicit.sites?.length);
    const fields =
      visible && prior
        ? mergeResponseArtifacts(
            explicit,
            (accumulated ??= mergeResponseArtifacts(...prior.forwarded, ...prior.owned)),
          )
        : explicit;
    const value = presentation(
      ownsNative && native.length ? mergeResponseArtifacts(fields, ...native.splice(0)) : fields,
      totals,
    );
    if (!value) continue;
    stored.battyPresentation = value;
    ++totals.replies;
    changed = true;
  }
  return changed;
}

interface ReportSubmission {
  entry: number;
  answer: number;
  type: string;
  status: string;
}
async function recoverNotice(tx: SqliteExecutor, entry: EntryRecord, data: LegacyData) {
  const source = (data.cron ?? data.subagent) as { sessionId?: string } | undefined;
  if (!source?.sessionId || !data.runtimeNotice) return undefined;
  const report = await tx.get<{ requestId: string }>(
    `SELECT json_extract(record, '$.requestId') AS requestId FROM submissions
     WHERE conversation_id=? AND json_extract(record, '$.entry')=?
       AND json_extract(record, '$.requestId') GLOB 'batty-report:*' ORDER BY id ASC LIMIT 1`,
    entry.conversationId,
    entry.id,
  );
  if (!report) return undefined;
  const requestId = `batty-deliver:${report.requestId.slice("batty-report:".length)}`;
  const sourceRow = await tx.get<{ record: string }>(
    "SELECT record FROM submissions WHERE conversation_id=? AND request_id=?",
    Number(source.sessionId),
    JSON.stringify(requestId),
  );
  if (!sourceRow) return undefined;
  const sourceSubmission = JSON.parse(sourceRow.record) as ReportSubmission;
  if (sourceSubmission.type !== "input" || sourceSubmission.status !== "done") return undefined;
  const entries = await readDeliveryEntries(tx, Number(source.sessionId), sourceSubmission);
  return legacyRuntimeResultArtifacts(entries);
}

async function readDeliveryEntries(
  tx: SqliteExecutor,
  conversationId: number,
  submission: ReportSubmission,
) {
  const entries: EntryRecord[] = [];
  let upper = submission.answer;
  while (upper >= submission.entry) {
    const rows = await tx.all<{ record: string }>(
      "SELECT record FROM entries WHERE conversation_id=? AND id>=? AND id<=? ORDER BY id DESC",
      conversationId,
      submission.entry,
      upper,
    );
    for (const { record } of rows) entries.push(JSON.parse(record));
    const parent = await tx.get<{ conversationId: number; at: number }>(
      `SELECT json_extract(record,'$.parent.conversationId') AS conversationId,
              json_extract(record,'$.parent.at') AS at FROM conversations
        WHERE id=? AND json_type(record,'$.parent')='object'`,
      conversationId,
    );
    if (!parent) break;
    conversationId = parent.conversationId;
    upper = Math.min(upper, parent.at);
  }
  return entries.reverse();
}

async function convertNoticeData(
  tx: SqliteExecutor,
  entry: EntryRecord,
  data: LegacyData | undefined,
  direct: boolean,
  canRecover: boolean,
  totals: MigrationCounts,
) {
  if (!data || data.runtimePresentation !== undefined) return false;
  let stored = data.runtimeResultArtifacts;
  if (!stored && !direct && canRecover && data.runtimeNotice && (data.cron || data.subagent)) {
    stored = await recoverNotice(tx, entry, data);
    if (!stored) ++totals.unrecoveredNotices;
  }
  if (!stored) return false;
  const value = presentation(direct ? stored : (stored.reportAttachments ?? stored), totals);
  if (!value) return false;
  data.runtimePresentation = value;
  ++totals.notices;
  return true;
}

function isNotice(type: unknown) {
  return typeof type === "string" && type.startsWith(BATTY_RUNTIME_NOTICE_CUSTOM_TYPE);
}

async function convertNotices(tx: SqliteExecutor, entry: EntryRecord, totals: MigrationCounts) {
  let changed = false;
  if (entry.model?.length) {
    const messages = entry.model as Array<
      Message | { role: "custom"; customType: string; details?: LegacyData }
    >;
    for (const [index, message] of messages.entries()) {
      if ((message as { display?: unknown }).display === false) continue;
      if (message.role === "user") {
        const uploads = (message as { battyAttachments?: unknown[] }).battyAttachments;
        if (Array.isArray(uploads)) totals.uploadedInputs += uploads.length;
        const notice = decodeRuntimeNotice(message.content);
        if (!notice) continue;
        const source = notice.data?.subagent as { sessionId?: string } | undefined;
        if (source?.sessionId?.startsWith("remote:")) ++totals.remoteNotices;
        if (
          await convertNoticeData(
            tx,
            entry,
            notice.data,
            notice.kind === "cron" && Boolean(notice.data?.directDelivery),
            index === 0,
            totals,
          )
        ) {
          const encoded = encodeRuntimeNotice(notice);
          if (typeof message.content === "string") message.content = encoded;
          else if (message.content[0]?.type === "text") message.content[0].text = encoded;
          changed = true;
        }
      } else if (message.role === "custom" && isNotice(message.customType)) {
        changed =
          (await convertNoticeData(tx, entry, message.details, false, index === 0, totals)) ||
          changed;
      }
    }
  } else {
    const data = entry.data as
      | (LegacyData & {
          original?: {
            type?: string;
            display?: boolean;
            customType?: string;
            details?: LegacyData;
          };
        })
      | undefined;
    const original = data?.original;
    if (
      original?.type === "custom_message" &&
      original.display !== false &&
      isNotice(original.customType)
    ) {
      changed = await convertNoticeData(tx, entry, original.details, false, true, totals);
    } else if (typeof data?.text === "string" && isNotice(entry.kind)) {
      changed = await convertNoticeData(tx, entry, data, false, true, totals);
    }
  }
  return changed;
}

function legacyResponseCandidate(message: Message): boolean {
  if (message.role !== "toolResult") return false;
  const details = message.details as
    | {
        forwardedArtifacts?: unknown;
        calls?: {
          name?: string;
          details?: { forwardedArtifacts?: unknown };
          forwardedArtifacts?: unknown;
        }[];
        sites?: { browserId?: unknown }[];
      }
    | undefined;
  const object = (value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  return (
    ["attach_files", "sites"].includes(message.toolName) ||
    object(details?.forwardedArtifacts) ||
    Boolean(
      details?.calls?.some(
        (call) =>
          ["attach_files", "sites", "browser"].includes(call.name ?? "") ||
          object(call.details?.forwardedArtifacts) ||
          object(call.forwardedArtifacts),
      ),
    ) ||
    Boolean(details?.sites?.some((site) => typeof site.browserId === "string"))
  );
}

const eventRows = `SELECT record FROM entries WHERE id>? AND (
  instr(record,'"assistant"') OR instr(record,'"attach_files"') OR instr(record,'"sites"')
    OR instr(record,'"forwardedArtifacts"') OR instr(record,'"browser"')
    OR instr(record,'batty-runtime-notice') OR instr(record,'"battyAttachments"')) ORDER BY id LIMIT ?`;

export async function migrateArtifactPresentation(database: SqliteDatabase, inspect = false) {
  return database.transaction(async (tx) => {
    const existing = await readMarker(tx);
    if (existing) return existing;
    const totals = counts();
    const pending = new Map<number, ReturnType<typeof legacyReplySources>>();
    const nativeByConversation = new Map<number, ArtifactFields[]>();
    let id = 0;
    while (true) {
      const rows = await tx.all<{ record: string }>(eventRows, id, batchSize);
      if (!rows.length) break;
      for (const { record } of rows) {
        const entry = JSON.parse(record) as EntryRecord;
        id = entry.id;
        const prior = pending.get(entry.conversationId);
        const native = nativeByConversation.get(entry.conversationId) ?? [];
        const replyChanged = convertReplies(entry, prior, native, totals);
        const noticeChanged = await convertNotices(tx, entry, totals);
        if (replyChanged || noticeChanged) {
          ++totals.entries;
          if (!inspect) {
            const updated = JSON.stringify(entry);
            await tx.run("UPDATE entries SET record=? WHERE id=?", updated, id);
            const saved = await tx.get<{ record: string }>(
              "SELECT record FROM entries WHERE id=?",
              id,
            );
            if (saved?.record !== updated)
              throw new Error(`Artifact migration integrity failure at entry ${id}`);
          }
        }
        if (entry.model?.some(rawBoundary)) pending.delete(entry.conversationId);
        else if (entry.model?.some(legacyResponseCandidate)) {
          const sources = legacyReplySources(entry.model);
          if (prior) {
            prior.forwarded.push(...sources.forwarded);
            prior.owned.push(...sources.owned);
          } else {
            pending.set(entry.conversationId, sources);
          }
        }
        if (native.length) nativeByConversation.set(entry.conversationId, native);
        else nativeByConversation.delete(entry.conversationId);
      }
    }
    totals.terminalNativeGroups = nativeByConversation.size;
    if (!inspect) await writeMarker(tx, totals);
    return totals;
  });
}
