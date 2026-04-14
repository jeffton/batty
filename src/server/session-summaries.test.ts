import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { AppConfig } from "@/server/config";
import { latestSessionUpdatedAt, listSessionSummaries } from "@/server/session-summaries";
import { workspaceSessionDir } from "@/server/pi-paths";
import { CRON_SESSION_CUSTOM_TYPE } from "@/server/cron-session";
import type { WorkspaceInfo } from "@/shared/types";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createConfig(): Promise<AppConfig> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-session-summaries-"));
  tempDirs.push(root);

  return {
    host: "127.0.0.1",
    port: 3147,
    workspacesRoot: root,
    selfPath: path.join(root, "self-project"),
    battyDir: root,
    uploadsDir: path.join(root, "uploads"),
    publicDir: path.join(root, "public"),
    webPushDir: path.join(root, "web-push"),
    webPushSubject: "mailto:test@example.com",
    cronDailySessionStartTime: "04:00",
    cookieName: "test",
    authSecret: crypto.randomUUID(),
  };
}

function workspaceInfo(config: AppConfig, workspaceId: string): WorkspaceInfo {
  return {
    id: workspaceId,
    label: workspaceId,
    path: path.join(config.workspacesRoot, workspaceId),
    kind: "workspace",
    isPinned: false,
  };
}

async function writeSession(
  config: AppConfig,
  workspaceId: string,
  fileName: string,
  updatedAt: string,
  entries: unknown[],
): Promise<string> {
  const sessionDir = workspaceSessionDir(config, workspaceId);
  await fs.mkdir(sessionDir, { recursive: true });
  const sessionPath = path.join(sessionDir, fileName);
  await fs.writeFile(sessionPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  const date = new Date(updatedAt);
  await fs.utimes(sessionPath, date, date);
  return sessionPath;
}

describe("session summaries", () => {
  it("lists sessions using file mtime and first user message", async () => {
    const config = await createConfig();
    const workspace = workspaceInfo(config, "alpha");
    await fs.mkdir(workspace.path, { recursive: true });

    const olderPath = await writeSession(
      config,
      workspace.id,
      "older.jsonl",
      "2026-03-24T12:00:00Z",
      [
        { type: "session", version: 3, id: "older-id", timestamp: "2026-03-01T00:00:00Z" },
        {
          type: "message",
          id: "older-1",
          message: {
            role: "user",
            content: [{ type: "text", text: "older first message" }],
          },
        },
      ],
    );
    await writeSession(config, workspace.id, "newer.jsonl", "2026-03-25T12:00:00Z", [
      { type: "session", version: 3, id: "newer-id", timestamp: "2026-01-01T00:00:00Z" },
      {
        type: "message",
        id: "newer-1",
        message: {
          role: "user",
          content: "newer first message",
        },
      },
    ]);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-25T12:00:00Z"));
    try {
      const sessions = await listSessionSummaries(config, workspace);

      expect(sessions).toEqual([
        {
          id: "daily:alpha:2026-03-25",
          sessionId: "daily:alpha:2026-03-25",
          firstMessage: "(no messages)",
          updatedAt: new Date("2026-03-25T12:00:00Z").getTime(),
          messageCount: 0,
          workspaceId: workspace.id,
          dailySession: {
            date: "2026-03-25",
            isToday: true,
            exists: false,
          },
        },
        {
          id: path.join(workspaceSessionDir(config, workspace.id), "newer.jsonl"),
          sessionId: "newer-id",
          path: path.join(workspaceSessionDir(config, workspace.id), "newer.jsonl"),
          firstMessage: "newer first message",
          updatedAt: new Date("2026-03-25T12:00:00Z").getTime(),
          messageCount: 0,
          workspaceId: workspace.id,
        },
        {
          id: olderPath,
          sessionId: "older-id",
          path: olderPath,
          firstMessage: "older first message",
          updatedAt: new Date("2026-03-24T12:00:00Z").getTime(),
          messageCount: 0,
          workspaceId: workspace.id,
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to a placeholder when no user message exists", async () => {
    const config = await createConfig();
    const workspace = workspaceInfo(config, "beta");
    await fs.mkdir(workspace.path, { recursive: true });

    await writeSession(config, workspace.id, "empty.jsonl", "2026-03-25T12:00:00Z", [
      { type: "session", version: 3, id: "empty-id", timestamp: "2026-01-01T00:00:00Z" },
      {
        type: "message",
        id: "assistant-1",
        message: { role: "assistant", content: "hello" },
      },
    ]);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-25T12:00:00Z"));
    try {
      const sessions = await listSessionSummaries(config, workspace);

      expect(sessions[1]?.firstMessage).toBe("(no messages)");
    } finally {
      vi.useRealTimers();
    }
  });

  it("puts today's daily session first and preserves daily metadata", async () => {
    const config = await createConfig();
    const workspace = workspaceInfo(config, "daily");
    await fs.mkdir(workspace.path, { recursive: true });

    await writeSession(config, workspace.id, "older.jsonl", "2026-03-24T12:00:00Z", [
      { type: "session", version: 3, id: "older-id", timestamp: "2026-03-24T12:00:00Z" },
      {
        type: "custom",
        customType: CRON_SESSION_CUSTOM_TYPE,
        data: { version: 1, kind: "daily", date: "2026-03-24" },
      },
    ]);
    const todayPath = await writeSession(
      config,
      workspace.id,
      "today.jsonl",
      "2026-03-20T12:00:00Z",
      [
        { type: "session", version: 3, id: "today-id", timestamp: "2026-03-31T12:00:00Z" },
        {
          type: "custom",
          customType: CRON_SESSION_CUSTOM_TYPE,
          data: { version: 1, kind: "daily", date: "2026-03-31" },
        },
      ],
    );
    await writeSession(config, workspace.id, "newer.jsonl", "2026-03-25T12:00:00Z", [
      { type: "session", version: 3, id: "newer-id", timestamp: "2026-03-25T12:00:00Z" },
    ]);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-31T12:00:00Z"));
    try {
      const sessions = await listSessionSummaries(config, workspace);

      expect(sessions[0]).toEqual({
        id: todayPath,
        sessionId: "today-id",
        path: todayPath,
        firstMessage: "(no messages)",
        updatedAt: new Date("2026-03-20T12:00:00Z").getTime(),
        messageCount: 0,
        workspaceId: workspace.id,
        dailySession: {
          date: "2026-03-31",
          isToday: true,
          exists: true,
        },
      });
      expect(sessions.map((session) => session.sessionId)).toEqual([
        "today-id",
        "newer-id",
        "older-id",
      ]);
      expect(sessions[2]?.dailySession).toEqual({
        date: "2026-03-24",
        isToday: false,
        exists: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("adds a synthetic entry when today's daily session does not exist", async () => {
    const config = await createConfig();
    const workspace = workspaceInfo(config, "missing-daily");
    await fs.mkdir(workspace.path, { recursive: true });

    await writeSession(config, workspace.id, "regular.jsonl", "2026-03-25T12:00:00Z", [
      { type: "session", version: 3, id: "regular-id", timestamp: "2026-03-25T12:00:00Z" },
    ]);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-31T12:00:00Z"));
    try {
      const sessions = await listSessionSummaries(config, workspace);

      expect(sessions[0]).toEqual({
        id: "daily:missing-daily:2026-03-31",
        sessionId: "daily:missing-daily:2026-03-31",
        firstMessage: "(no messages)",
        updatedAt: new Date("2026-03-31T12:00:00Z").getTime(),
        messageCount: 0,
        workspaceId: workspace.id,
        dailySession: {
          date: "2026-03-31",
          isToday: true,
          exists: false,
        },
      });
      expect(sessions[1]?.sessionId).toBe("regular-id");
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses file mtimes for latest workspace activity", async () => {
    const config = await createConfig();
    const workspace = workspaceInfo(config, "gamma");
    await fs.mkdir(workspace.path, { recursive: true });

    await writeSession(config, workspace.id, "older.jsonl", "2026-03-24T12:00:00Z", [
      { type: "session", version: 3, id: "older-id", timestamp: "2026-03-30T12:00:00Z" },
    ]);
    await writeSession(config, workspace.id, "newer.jsonl", "2026-03-25T12:00:00Z", [
      { type: "session", version: 3, id: "newer-id", timestamp: "2026-03-01T12:00:00Z" },
    ]);

    expect(await latestSessionUpdatedAt(config, workspace.id)).toBe(
      new Date("2026-03-25T12:00:00Z").getTime(),
    );
  });
});
