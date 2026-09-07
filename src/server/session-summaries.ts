import fs from "node:fs/promises";
import path from "node:path";
import type { SessionSummary, WorkspaceInfo } from "@/shared/types";
import type { AppConfig } from "./config";
import { battyAgentDir, battySessionRootDir, workspaceSessionDir } from "./pi-paths";
import { findLatestDailyCronSessionBinding, toLocalIsoDate } from "./cron-session";
import { isSubagentSessionEntry } from "./subagent";
import { HarnessSessionStore, type SessionRead } from "./harness-session-store";

const DEFAULT_SESSION_LABEL = "(no messages)";
const CRON_RUNTIME_NOTICE_CUSTOM_TYPE = "batty-runtime-notice:cron";
interface IndexEntry {
  workspaceId: string;
  updatedAt: number;
  summary?: SessionSummary;
  recovery: boolean;
}
interface StoredIndex {
  version: 1;
  entries: Record<string, IndexEntry>;
  completedWorkspaces: string[];
}
const indexes = new Map<string, Promise<SessionSummaryIndex>>();

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content.replace(/\s+/g, " ").trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block?.type === "text" ? block.text : block?.type === "thinking" ? block.thinking : "",
    )
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
}
function extractCronRuntimeNoticePrompt(content: unknown): string {
  if (typeof content !== "string") return "";
  const marker = "\nPrompt:\n";
  const index = content.indexOf(marker);
  return extractMessageText(index >= 0 ? content.slice(index + marker.length) : content);
}

function buildSessionSummary(
  { metadata, entries }: SessionRead,
  filePath: string,
  workspaceId: string,
  updatedAt: number,
): SessionSummary | undefined {
  if (
    metadata.parentSessionId ||
    metadata.legacyParentSessionPath ||
    entries.some(isSubagentSessionEntry)
  )
    return undefined;
  let firstMessage = "";
  let lastAssistantReplyAt: number | undefined;
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (!firstMessage && message.role === "user")
      firstMessage = extractMessageText(message.content);
    if (
      !firstMessage &&
      message.role === "custom" &&
      message.customType === CRON_RUNTIME_NOTICE_CUSTOM_TYPE
    )
      firstMessage = extractCronRuntimeNoticePrompt(message.content);
    if (message.role === "assistant")
      lastAssistantReplyAt = Math.max(lastAssistantReplyAt ?? 0, message.timestamp);
  }
  const daily = findLatestDailyCronSessionBinding(entries);
  return {
    id: filePath,
    sessionId: metadata.id,
    path: filePath,
    firstMessage: firstMessage || DEFAULT_SESSION_LABEL,
    updatedAt,
    messageCount: 0,
    workspaceId,
    ...(lastAssistantReplyAt !== undefined ? { lastAssistantReplyAt } : {}),
    ...(daily ? { dailySession: { date: daily.date, isToday: false, exists: true } } : {}),
  };
}

/** Prune cron trees before reading their directories, not after recursive enumeration. */
async function sessionFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory() && entry.name !== "cron") files.push(...(await sessionFiles(file)));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(file);
  }
  return files;
}

/** Rebuildable metadata only. Ordinary list requests never inspect transcript files. */
export class SessionSummaryIndex {
  private readonly entries = new Map<string, IndexEntry>();
  private readonly revisions = new Map<string, number>();
  private readonly completedWorkspaces = new Set<string>();
  private readonly initializations = new Map<string, Promise<void>>();
  private readonly filePath: string;
  private readonly unsubscribe: () => void;
  private ready!: Promise<void>;
  private writeQueue = Promise.resolve();
  private dirty = false;
  private persistTimer?: NodeJS.Timeout;
  private stopped = false;

  private constructor(private readonly config: Pick<AppConfig, "battyDir">) {
    this.filePath = path.join(battyAgentDir(config), "session-summary-index.json");
    // Subscribe before loading: disk state must not overwrite a concurrent Batty write.
    this.unsubscribe = HarnessSessionStore.subscribe((file, snapshot) => {
      const workspaceId = this.workspaceId(file);
      if (!workspaceId) return;
      this.bump(file);
      if (snapshot)
        this.entries.set(
          file,
          this.buildEntry(file, workspaceId, snapshot, snapshot.metadata.modifiedAt),
        );
      else this.entries.delete(file);
      this.changed();
    });
  }

  static async create(config: Pick<AppConfig, "battyDir">): Promise<SessionSummaryIndex> {
    const index = new SessionSummaryIndex(config);
    index.ready = index.load();
    try {
      await index.ready;
      return index;
    } catch (error) {
      index.unsubscribe();
      clearTimeout(index.persistTimer);
      throw error;
    }
  }

  private workspaceId(file: string): string | undefined {
    const relative = path.relative(path.resolve(battySessionRootDir(this.config)), file);
    const parts = relative.split(path.sep);
    return !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative) &&
      parts.length > 1 &&
      !parts.slice(1, -1).includes("cron") &&
      file.endsWith(".jsonl")
      ? parts[0]
      : undefined;
  }

  private async invalidateCache(reason: string, error: Error): Promise<void> {
    const invalidFile = `${this.filePath}.invalid-${Date.now()}`;
    await fs.rename(this.filePath, invalidFile);
    console.error("Invalid session summary index; rebuilding", {
      file: this.filePath,
      invalidFile,
      reason,
      error,
    });
  }

  private async load(): Promise<void> {
    let content: string;
    try {
      content = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    let stored: StoredIndex;
    try {
      stored = JSON.parse(content) as StoredIndex;
    } catch (error) {
      await this.invalidateCache("malformed JSON", error as Error);
      return;
    }
    if (stored?.version !== 1) {
      const error = new Error(`Unsupported session summary index: ${stored?.version}`);
      await this.invalidateCache("unsupported version", error);
      return;
    }
    if (
      !stored.entries ||
      typeof stored.entries !== "object" ||
      Array.isArray(stored.entries) ||
      !Array.isArray(stored.completedWorkspaces) ||
      !stored.completedWorkspaces.every((id) => typeof id === "string") ||
      !Object.values(stored.entries).every(
        (entry) =>
          entry &&
          typeof entry.workspaceId === "string" &&
          typeof entry.updatedAt === "number" &&
          typeof entry.recovery === "boolean" &&
          (!entry.summary ||
            (typeof entry.summary.sessionId === "string" &&
              typeof entry.summary.path === "string" &&
              typeof entry.summary.firstMessage === "string" &&
              typeof entry.summary.updatedAt === "number")),
      )
    ) {
      await this.invalidateCache(
        "invalid index structure",
        new Error("Invalid index entries or completed workspaces"),
      );
      return;
    }
    for (const workspaceId of stored.completedWorkspaces) this.completedWorkspaces.add(workspaceId);
    for (const [file, entry] of Object.entries(stored.entries)) {
      if (!this.revisions.has(file)) this.entries.set(file, entry);
    }
  }

  private buildEntry(
    file: string,
    workspaceId: string,
    snapshot: SessionRead,
    updatedAt: number,
  ): IndexEntry {
    const marker = snapshot.entries.findLast(isSubagentSessionEntry);
    const detached =
      marker?.type === "custom"
        ? (marker.data as { sessionId?: string; respondIn?: string; request?: unknown })
        : undefined;
    return {
      workspaceId,
      updatedAt,
      summary: buildSessionSummary(snapshot, file, workspaceId, updatedAt),
      // Hidden detached sessions still need restart recovery; cron runs have their own index.
      recovery: Boolean(
        snapshot.currentOperationId ||
        (detached?.sessionId === snapshot.metadata.id &&
          detached.respondIn === "session" &&
          detached.request),
      ),
    };
  }

  private bump(file: string): void {
    this.revisions.set(file, (this.revisions.get(file) ?? 0) + 1);
  }

  private changed(): void {
    this.dirty = true;
    if (!this.persistTimer && !this.stopped) {
      this.persistTimer = setTimeout(() => {
        this.persistTimer = undefined;
        void this.flush().catch((error) =>
          console.error("Failed to persist session summary index", error),
        );
      }, 100);
      this.persistTimer.unref();
    }
  }

  async flush(): Promise<void> {
    await this.ready;
    const writing = this.writeQueue.then(async () => {
      if (!this.dirty) return;
      this.dirty = false;
      const stored: StoredIndex = {
        version: 1,
        entries: Object.fromEntries(this.entries),
        completedWorkspaces: [...this.completedWorkspaces],
      };
      try {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        const temporary = `${this.filePath}.tmp`;
        await fs.writeFile(temporary, `${JSON.stringify(stored)}\n`, "utf8");
        await fs.rename(temporary, this.filePath);
      } catch (error) {
        this.dirty = true;
        throw error;
      }
    });
    this.writeQueue = writing.catch(() => {});
    await writing;
  }

  list(workspaceId: string, todayDate: string): SessionSummary[] {
    const sessions = [...this.entries.values()].flatMap((entry) => {
      if (entry.workspaceId !== workspaceId || !entry.summary) return [];
      const summary = entry.summary;
      return [
        {
          ...summary,
          ...(summary.dailySession
            ? {
                dailySession: {
                  ...summary.dailySession,
                  isToday: summary.dailySession.date === todayDate,
                },
              }
            : {}),
        },
      ];
    });
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    const daily = sessions.find((session) => session.dailySession?.date === todayDate);
    if (daily) return [daily, ...sessions.filter((session) => session !== daily)];
    return [
      {
        id: `daily:${workspaceId}:${todayDate}`,
        sessionId: `daily:${workspaceId}:${todayDate}`,
        firstMessage: DEFAULT_SESSION_LABEL,
        updatedAt: Date.now(),
        messageCount: 0,
        workspaceId,
        dailySession: { date: todayDate, isToday: true, exists: false },
      },
      ...sessions,
    ];
  }

  latestUpdatedAt(workspaceId: string): number | undefined {
    const times = [...this.entries.values()]
      .filter((entry) => entry.workspaceId === workspaceId)
      .map((entry) => entry.updatedAt);
    return times.length ? Math.max(...times) : undefined;
  }

  recoveryPaths(workspaceId: string): string[] {
    return [...this.entries]
      .filter(([, entry]) => entry.workspaceId === workspaceId && entry.recovery)
      .map(([file]) => file);
  }

  /** Discover each workspace once, including workspaces added after startup. */
  async ensureInitialized(workspaceId: string): Promise<void> {
    await this.ready;
    if (this.completedWorkspaces.has(workspaceId)) return;
    const existing = this.initializations.get(workspaceId);
    if (existing) return existing;
    const running = this.initializeWorkspace(workspaceId).finally(() =>
      this.initializations.delete(workspaceId),
    );
    this.initializations.set(workspaceId, running);
    return running;
  }

  private async initializeWorkspace(workspaceId: string): Promise<void> {
    await this.ready;
    const revisions = new Map(this.revisions);
    const unchanged = (file: string) => this.revisions.get(file) === revisions.get(file);
    const files = await sessionFiles(workspaceSessionDir(this.config, workspaceId));
    const errors: unknown[] = [];
    // One Pi reader at a time bounds legacy import memory and yields between large histories.
    for (const file of files) {
      try {
        if (this.revisions.has(file)) continue;
        const snapshot = await HarnessSessionStore.read(file, { readOnly: true });
        if (!unchanged(file)) continue;
        this.entries.set(
          file,
          this.buildEntry(file, workspaceId, snapshot, snapshot.metadata.modifiedAt),
        );
        this.changed();
      } catch (error) {
        if (!unchanged(file)) continue;
        errors.push(error);
        console.error("Failed to index session summary", { file, error });
      }
    }
    if (errors.length) {
      await this.flush();
      throw new AggregateError(
        errors,
        `Session discovery is incomplete for workspace ${workspaceId}`,
      );
    }
    this.completedWorkspaces.add(workspaceId);
    this.changed();
    await this.flush();
  }

  async dispose(): Promise<void> {
    this.stopped = true;
    await Promise.all(this.initializations.values());
    this.unsubscribe();
    clearTimeout(this.persistTimer);
    await this.flush();
  }
}

export function getSessionSummaryIndex(
  config: Pick<AppConfig, "battyDir">,
): Promise<SessionSummaryIndex> {
  const key = path.resolve(config.battyDir);
  let index = indexes.get(key);
  if (!index) {
    index = SessionSummaryIndex.create(config);
    indexes.set(key, index);
  }
  return index;
}

export async function disposeSessionSummaryIndex(
  config: Pick<AppConfig, "battyDir">,
): Promise<void> {
  const key = path.resolve(config.battyDir);
  const index = indexes.get(key);
  if (index) {
    await (await index).dispose();
    indexes.delete(key);
  }
}

export async function listSessionSummaries(
  config: Pick<AppConfig, "battyDir" | "cronDailySessionStartTime">,
  workspace: WorkspaceInfo,
): Promise<SessionSummary[]> {
  const index = await getSessionSummaryIndex(config);
  await index.ensureInitialized(workspace.id);
  return index.list(workspace.id, toLocalIsoDate(new Date(), config.cronDailySessionStartTime));
}

export async function latestSessionUpdatedAt(
  config: Pick<AppConfig, "battyDir">,
  workspaceId: string,
): Promise<number | undefined> {
  const index = await getSessionSummaryIndex(config);
  await index.ensureInitialized(workspaceId);
  return index.latestUpdatedAt(workspaceId);
}
