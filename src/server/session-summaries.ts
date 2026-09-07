import fs from "node:fs/promises";
import path from "node:path";
import type { SessionSummary, WorkspaceInfo } from "@/shared/types";
import type { AppConfig } from "./config";
import { workspaceSessionDir } from "./pi-paths";
import { findLatestDailyCronSessionBinding, toLocalIsoDate } from "./cron-session";
import { isSubagentSessionEntry } from "./subagent";
import { HarnessSessionStore } from "./harness-session-store";

const DEFAULT_SESSION_LABEL = "(no messages)";
const SESSION_SUMMARY_READ_CONCURRENCY = 16;
const CRON_RUNTIME_NOTICE_CUSTOM_TYPE = "batty-runtime-notice:cron";
type CacheEntry = { mtimeMs: number; size: number; summary: SessionSummary | undefined };
const sessionSummaryCaches = new Map<string, Map<string, CacheEntry>>();

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

async function buildSessionSummary(
  filePath: string,
  workspaceId: string,
  todayDate: string,
  mtimeMs: number,
): Promise<SessionSummary | undefined> {
  const { metadata, entries } = await HarnessSessionStore.read(filePath);
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
    updatedAt: mtimeMs,
    messageCount: 0,
    workspaceId,
    ...(lastAssistantReplyAt !== undefined ? { lastAssistantReplyAt } : {}),
    ...(daily
      ? { dailySession: { date: daily.date, isToday: daily.date === todayDate, exists: true } }
      : {}),
  };
}

async function sessionFiles(sessionDir: string): Promise<string[]> {
  const entries = await fs
    .readdir(sessionDir, { recursive: true, withFileTypes: true })
    .catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".jsonl") &&
        !path.relative(sessionDir, entry.parentPath).split(path.sep).includes("cron"),
    )
    .map((entry) => path.join(entry.parentPath, entry.name));
}
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = Array.from<R>({ length: items.length });
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        results[index] = await mapper(items[index]!);
      }
    }),
  );
  return results;
}

export async function listSessionSummaries(
  config: Pick<AppConfig, "battyDir" | "cronDailySessionStartTime">,
  workspace: WorkspaceInfo,
): Promise<SessionSummary[]> {
  const files = await sessionFiles(workspaceSessionDir(config, workspace.id));
  const todayDate = toLocalIsoDate(new Date(), config.cronDailySessionStartTime);
  const key = `${config.battyDir}:${workspace.id}`;
  const cache = sessionSummaryCaches.get(key) ?? new Map<string, CacheEntry>();
  sessionSummaryCaches.set(key, cache);
  const seenPaths = new Set(files);
  for (const cachedPath of cache.keys()) if (!seenPaths.has(cachedPath)) cache.delete(cachedPath);
  const summaries = await mapWithConcurrency(
    files,
    SESSION_SUMMARY_READ_CONCURRENCY,
    async (filePath) => {
      const stats = await fs.stat(filePath);
      const cached = cache.get(filePath);
      if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
        const summary = cached.summary;
        return summary
          ? {
              ...summary,
              ...(summary.dailySession
                ? {
                    dailySession: {
                      ...summary.dailySession,
                      isToday: summary.dailySession.date === todayDate,
                    },
                  }
                : {}),
            }
          : undefined;
      }
      const summary = await buildSessionSummary(filePath, workspace.id, todayDate, stats.mtimeMs);
      cache.set(filePath, { mtimeMs: stats.mtimeMs, size: stats.size, summary });
      return summary;
    },
  );
  const sessions = summaries.filter((session): session is SessionSummary => Boolean(session));
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  const daily = sessions.find((session) => session.dailySession?.date === todayDate);
  if (daily) return [daily, ...sessions.filter((session) => session !== daily)];
  return [
    {
      id: `daily:${workspace.id}:${todayDate}`,
      sessionId: `daily:${workspace.id}:${todayDate}`,
      firstMessage: DEFAULT_SESSION_LABEL,
      updatedAt: Date.now(),
      messageCount: 0,
      workspaceId: workspace.id,
      dailySession: { date: todayDate, isToday: true, exists: false },
    },
    ...sessions,
  ];
}

export async function latestSessionUpdatedAt(
  config: Pick<AppConfig, "battyDir">,
  workspaceId: string,
): Promise<number | undefined> {
  const files = await sessionFiles(workspaceSessionDir(config, workspaceId));
  const mtimes = await Promise.all(
    files.map((file) => fs.stat(file).then((stats) => stats.mtimeMs)),
  );
  return mtimes.length ? Math.max(...mtimes) : undefined;
}
