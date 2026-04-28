import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import type { SessionSummary, WorkspaceInfo } from "@/shared/types";
import type { AppConfig } from "./config";
import { workspaceSessionDir } from "./pi-paths";
import {
  CRON_SESSION_CUSTOM_TYPE,
  findLatestDailyCronSessionBinding,
  toLocalIsoDate,
} from "./cron-session";
import { isSubagentSessionEntry } from "./subagent";

const DEFAULT_SESSION_LABEL = "(no messages)";
const SESSION_SUMMARY_READ_CONCURRENCY = 4;

function extractMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content.replace(/\s+/g, " ").trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }

      const candidate = block as { type?: unknown; text?: unknown; thinking?: unknown };
      if (candidate.type === "text" && typeof candidate.text === "string") {
        return candidate.text;
      }
      if (candidate.type === "thinking" && typeof candidate.thinking === "string") {
        return candidate.thinking;
      }
      return "";
    })
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
}

async function readSessionHeaderAndFirstUserMessage(filePath: string): Promise<{
  sessionId?: string;
  firstMessage: string;
  dailySessionDate?: string;
  isSubagentSession: boolean;
}> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let sessionId: string | undefined;
  let firstMessage = "";
  let dailySessionDate: string | undefined;
  let isSubagentSession = false;

  try {
    for await (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (!entry || typeof entry !== "object") {
        continue;
      }

      const candidate = entry as {
        type?: unknown;
        id?: unknown;
        customType?: unknown;
        data?: unknown;
        message?: { role?: unknown; content?: unknown };
      };

      if (!sessionId && candidate.type === "session" && typeof candidate.id === "string") {
        sessionId = candidate.id;
      }

      if (candidate.type === "message" && candidate.message?.role === "user" && !firstMessage) {
        firstMessage = extractMessageText(candidate.message.content);
      }

      if (isSubagentSessionEntry(candidate)) {
        isSubagentSession = true;
      }

      if (candidate.type === "custom" && candidate.customType === CRON_SESSION_CUSTOM_TYPE) {
        const binding = findLatestDailyCronSessionBinding([
          {
            type: "custom",
            customType: candidate.customType,
            data: candidate.data,
          },
        ]);
        if (binding) {
          dailySessionDate = binding.date;
        }
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }

  return { sessionId, firstMessage, dailySessionDate, isSubagentSession };
}

async function buildSessionSummary(
  filePath: string,
  workspaceId: string,
  todayDate: string,
): Promise<SessionSummary | undefined> {
  try {
    const [{ sessionId, firstMessage, dailySessionDate, isSubagentSession }, stats] =
      await Promise.all([readSessionHeaderAndFirstUserMessage(filePath), fs.stat(filePath)]);

    if (!sessionId || isSubagentSession) {
      return undefined;
    }

    return {
      id: filePath,
      sessionId,
      path: filePath,
      firstMessage: firstMessage || DEFAULT_SESSION_LABEL,
      updatedAt: stats.mtime.getTime(),
      messageCount: 0,
      workspaceId,
      ...(dailySessionDate
        ? {
            dailySession: {
              date: dailySessionDate,
              isToday: dailySessionDate === todayDate,
              exists: true,
            },
          }
        : {}),
    };
  } catch {
    return undefined;
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]!);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      await worker();
    }),
  );

  return results;
}

export async function listSessionSummaries(
  config: Pick<AppConfig, "battyDir" | "cronDailySessionStartTime">,
  workspace: WorkspaceInfo,
): Promise<SessionSummary[]> {
  const sessionDir = workspaceSessionDir(config, workspace.id);
  const entries = await fs.readdir(sessionDir, { withFileTypes: true }).catch(() => []);
  const sessionFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(sessionDir, entry.name));

  const todayDate = toLocalIsoDate(new Date(), config.cronDailySessionStartTime);
  const sessions = (
    await mapWithConcurrency(sessionFiles, SESSION_SUMMARY_READ_CONCURRENCY, (filePath) =>
      buildSessionSummary(filePath, workspace.id, todayDate),
    )
  ).filter((session): session is SessionSummary => Boolean(session));

  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  const todayDailySession = sessions.find((session) => session.dailySession?.date === todayDate);
  if (todayDailySession) {
    return [todayDailySession, ...sessions.filter((session) => session !== todayDailySession)];
  }

  return [
    {
      id: `daily:${workspace.id}:${todayDate}`,
      sessionId: `daily:${workspace.id}:${todayDate}`,
      firstMessage: DEFAULT_SESSION_LABEL,
      updatedAt: Date.now(),
      messageCount: 0,
      workspaceId: workspace.id,
      dailySession: {
        date: todayDate,
        isToday: true,
        exists: false,
      },
    },
    ...sessions,
  ];
}

export async function latestSessionUpdatedAt(
  config: Pick<AppConfig, "battyDir">,
  workspaceId: string,
): Promise<number | undefined> {
  const sessionDir = workspaceSessionDir(config, workspaceId);
  const entries = await fs.readdir(sessionDir, { withFileTypes: true }).catch(() => []);
  const sessionFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(sessionDir, entry.name));

  if (sessionFiles.length === 0) {
    return undefined;
  }

  const mtimes = await Promise.all(
    sessionFiles.map((filePath) => fs.stat(filePath).then((stats) => stats.mtime.getTime())),
  );

  return mtimes.reduce<number | undefined>(
    (latest, updatedAt) => (latest == null || updatedAt > latest ? updatedAt : latest),
    undefined,
  );
}
