import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import type { SessionSummary, WorkspaceInfo } from "@/shared/types";
import type { AppConfig } from "./config";
import { workspaceSessionDir } from "./pi-paths";

const DEFAULT_SESSION_LABEL = "(no messages)";

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

async function readSessionHeaderAndFirstUserMessage(
  filePath: string,
): Promise<{ sessionId?: string; firstMessage: string }> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let sessionId: string | undefined;
  let firstMessage = "";

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
        message?: { role?: unknown; content?: unknown };
      };

      if (!sessionId && candidate.type === "session" && typeof candidate.id === "string") {
        sessionId = candidate.id;
      }

      if (candidate.type === "message" && candidate.message?.role === "user" && !firstMessage) {
        firstMessage = extractMessageText(candidate.message.content);
      }

      if (sessionId && firstMessage) {
        lines.close();
        stream.destroy();
        break;
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }

  return { sessionId, firstMessage };
}

async function buildSessionSummary(
  filePath: string,
  workspaceId: string,
): Promise<SessionSummary | undefined> {
  try {
    const [{ sessionId, firstMessage }, stats] = await Promise.all([
      readSessionHeaderAndFirstUserMessage(filePath),
      fs.stat(filePath),
    ]);

    if (!sessionId) {
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
    };
  } catch {
    return undefined;
  }
}

export async function listSessionSummaries(
  config: Pick<AppConfig, "battyDir">,
  workspace: WorkspaceInfo,
): Promise<SessionSummary[]> {
  const sessionDir = workspaceSessionDir(config, workspace.id);
  const entries = await fs.readdir(sessionDir, { withFileTypes: true }).catch(() => []);
  const sessionFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(sessionDir, entry.name));

  const sessions = (
    await Promise.all(sessionFiles.map((filePath) => buildSessionSummary(filePath, workspace.id)))
  ).filter((session): session is SessionSummary => Boolean(session));

  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return sessions;
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
