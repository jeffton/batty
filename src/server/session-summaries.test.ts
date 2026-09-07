import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { AppConfig } from "@/server/config";
import {
  latestSessionUpdatedAt,
  listSessionSummaries,
  getSessionSummaryIndex,
  disposeSessionSummaryIndex,
  SessionSummaryIndex,
} from "@/server/session-summaries";
import { HarnessSessionStore } from "./harness-session-store";
import { HarnessController } from "./harness-controller";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { battyAgentDir, workspaceSessionDir } from "@/server/pi-paths";
import { CRON_RUN_SESSION_CUSTOM_TYPE, CRON_SESSION_CUSTOM_TYPE } from "@/server/cron-session";
import { SUBAGENT_SESSION_CUSTOM_TYPE } from "@/server/subagent";
import type { WorkspaceInfo } from "@/shared/types";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const battyDir of tempDirs.splice(0)) {
    await disposeSessionSummaryIndex({ battyDir });
    await fs.rm(battyDir, { recursive: true, force: true });
  }
});

async function createConfig(): Promise<AppConfig> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-session-summaries-"));
  tempDirs.push(root);

  return {
    host: "127.0.0.1",
    port: 3147,
    workspacesRoots: [root],
    selfPath: path.join(root, "self-project"),
    battyDir: root,
    uploadsDir: path.join(root, "uploads"),
    sentFilesDir: path.join(root, "sent-files"),
    publicDir: path.join(root, "public"),
    webPushDir: path.join(root, "web-push"),
    webPushSubject: "mailto:test@example.com",
    cronDailySessionStartTime: "04:00",
    baseUrl: "/",
    appTitle: "Batty",
    appColor: "neutral",
    cookieName: "test",
    authSecret: crypto.randomUUID(),
  };
}

function workspaceInfo(config: AppConfig, workspaceId: string): WorkspaceInfo {
  return {
    id: workspaceId,
    label: workspaceId,
    path: path.join(config.workspacesRoots[0]!, workspaceId),
    kind: "workspace",
    isPinned: false,
    isAssistant: false,
  };
}

async function writeSession(
  config: AppConfig,
  workspaceId: string,
  fileName: string,
  updatedAt: string,
  entries: unknown[],
  resetIndex = true,
): Promise<string> {
  const sessionDir = workspaceSessionDir(config, workspaceId);
  await fs.mkdir(sessionDir, { recursive: true });
  const sessionPath = path.join(sessionDir, fileName);
  await fs.mkdir(path.dirname(sessionPath), { recursive: true });
  let parentId: string | null = null;
  const normalized = entries.map((raw) => {
    const entry = raw as Record<string, any>;
    if (entry.type === "session") return { cwd: workspaceInfo(config, workspaceId).path, ...entry };
    const result: Record<string, any> = {
      id: crypto.randomUUID(),
      parentId,
      timestamp: updatedAt,
      ...entry,
    };
    parentId = result.id;
    if (entry.message) {
      result.message = { timestamp: Date.parse(updatedAt), ...entry.message };
      if (entry.message.role === "assistant")
        result.message = {
          ...fauxAssistantMessage(entry.message.content),
          ...result.message,
          content:
            typeof entry.message.content === "string"
              ? [{ type: "text", text: entry.message.content }]
              : entry.message.content,
        };
    }
    if (entry.type === "custom_message") result.display = true;
    return result;
  });
  await fs.writeFile(
    sessionPath,
    `${normalized.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  const date = new Date(updatedAt);
  await fs.utimes(sessionPath, date, date);
  if (resetIndex) {
    await disposeSessionSummaryIndex(config);
    await fs.rm(path.join(battyAgentDir(config), "session-summary-index.json"), { force: true });
  }
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
        timestamp: "2026-03-25T11:59:00Z",
        message: { role: "assistant", content: "hello", timestamp: 123 },
      },
    ]);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-25T12:00:00Z"));
    try {
      const sessions = await listSessionSummaries(config, workspace);

      expect(sessions[1]?.firstMessage).toBe("(no messages)");
      expect(sessions[1]?.lastAssistantReplyAt).toBe(123);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not include persisted subagent sessions in the session list", async () => {
    const config = await createConfig();
    const workspace = workspaceInfo(config, "alpha");
    await fs.mkdir(workspace.path, { recursive: true });

    const subagentPath = await writeSession(
      config,
      workspace.id,
      "subagent.jsonl",
      "2026-03-25T12:00:00Z",
      [
        { type: "session", version: 3, id: "subagent-id", timestamp: "2026-03-25T12:00:00Z" },
        {
          type: "custom",
          customType: SUBAGENT_SESSION_CUSTOM_TYPE,
          data: { parentSessionId: "parent", respondIn: "session" },
        },
        {
          type: "custom",
          customType: CRON_SESSION_CUSTOM_TYPE,
          data: { kind: "daily", workspaceId: workspace.id, date: "2026-03-25" },
        },
        {
          type: "message",
          id: "subagent-1",
          message: {
            role: "user",
            content: [{ type: "text", text: "cron prompt" }],
          },
        },
      ],
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-25T12:00:00Z"));
    try {
      const sessions = await listSessionSummaries(config, workspace);

      expect(sessions.find((session) => session.path === subagentPath)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("includes parentless cron run sessions from the workspace session directory", async () => {
    const config = await createConfig();
    const workspace = workspaceInfo(config, "cron-parentless");
    await fs.mkdir(workspace.path, { recursive: true });

    const cronPath = await writeSession(
      config,
      workspace.id,
      "cron-run.jsonl",
      "2026-03-25T12:00:00Z",
      [
        { type: "session", version: 3, id: "cron-run-id", timestamp: "2026-03-25T12:00:00Z" },
        {
          type: "custom",
          customType: CRON_RUN_SESSION_CUSTOM_TYPE,
          data: { version: 1, kind: "run", jobId: "job-1", runId: "run-1" },
        },
        {
          type: "custom_message",
          customType: "batty-runtime-notice:cron",
          content:
            "Cron run triggered. Current time: 2026-03-25 12:00:00. Schedule: Every 1h\n\nPrompt:\nPublish Roy's Picks.",
        },
      ],
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-25T12:00:00Z"));
    try {
      const sessions = await listSessionSummaries(config, workspace);
      const cronSession = sessions.find((session) => session.path === cronPath);

      expect(cronSession).toEqual({
        id: cronPath,
        sessionId: "cron-run-id",
        path: cronPath,
        firstMessage: "Publish Roy's Picks.",
        updatedAt: new Date("2026-03-25T12:00:00Z").getTime(),
        messageCount: 0,
        workspaceId: workspace.id,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not include cron subdirectory sessions in the session list", async () => {
    const config = await createConfig();
    const workspace = workspaceInfo(config, "cron-parented");
    await fs.mkdir(workspace.path, { recursive: true });

    const cronPath = await writeSession(
      config,
      workspace.id,
      "cron/job-1/run-1/cron-run.jsonl",
      "2026-03-25T12:00:00Z",
      [
        { type: "session", version: 3, id: "cron-run-id", timestamp: "2026-03-25T12:00:00Z" },
        {
          type: "custom",
          customType: CRON_RUN_SESSION_CUSTOM_TYPE,
          data: {
            version: 1,
            kind: "run",
            jobId: "job-1",
            runId: "run-1",
            parentSessionId: "daily-session-id",
          },
        },
        {
          type: "custom_message",
          customType: "batty-runtime-notice:cron",
          content:
            "Cron run triggered. Current time: 2026-03-25 12:00:00. Schedule: Every 1h\n\nPrompt:\nSummarize work.",
        },
      ],
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-25T12:00:00Z"));
    try {
      const sessions = await listSessionSummaries(config, workspace);

      expect(sessions.find((session) => session.path === cronPath)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not include branched subagent sessions in the session list", async () => {
    const config = await createConfig();
    const workspace = workspaceInfo(config, "alpha");
    await fs.mkdir(workspace.path, { recursive: true });

    const entries: unknown[] = [
      {
        type: "session",
        version: 3,
        id: "branched-subagent-id",
        timestamp: "2026-03-25T12:00:00Z",
        parentSession: "/tmp/parent.jsonl",
      },
      {
        type: "message",
        id: "copied-context-message",
        message: {
          role: "user",
          content: [{ type: "text", text: "copied parent context" }],
        },
      },
    ];
    for (let index = 0; index < 140; index += 1) {
      entries.push({
        type: "message",
        id: `copied-${index}`,
        message: { role: "assistant", content: "ok" },
      });
    }
    entries.push({
      type: "custom",
      customType: SUBAGENT_SESSION_CUSTOM_TYPE,
      data: { parentSessionId: "parent", respondIn: "session" },
    });

    const subagentPath = await writeSession(
      config,
      workspace.id,
      "branched-subagent.jsonl",
      "2026-03-25T12:00:00Z",
      entries,
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-25T12:00:00Z"));
    try {
      const sessions = await listSessionSummaries(config, workspace);

      expect(sessions.find((session) => session.path === subagentPath)).toBeUndefined();
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

const legacyHeader = (id: string) => ({
  type: "session",
  version: 3,
  id,
  timestamp: "2026-03-25T12:00:00Z",
});

describe("persistent session summary index", () => {
  it("serves warm and restarted lists without directory scans, stats, or transcript reads", async () => {
    const config = await createConfig();
    const workspace = workspaceInfo(config, "warm");
    await writeSession(config, workspace.id, "one.jsonl", "2026-03-25T12:00:00Z", [
      legacyHeader("one"),
    ]);
    const index = await getSessionSummaryIndex(config);
    await index.ensureInitialized(workspace.id);
    await index.flush();
    const readdir = vi.spyOn(fs, "readdir");
    const stat = vi.spyOn(fs, "stat");
    const read = vi.spyOn(HarnessSessionStore, "read");
    const readFile = vi.spyOn(fs, "readFile");
    for (let i = 0; i < 5; i++) {
      expect((await listSessionSummaries(config, workspace))[1]?.sessionId).toBe("one");
      expect(await latestSessionUpdatedAt(config, workspace.id)).toBe(
        Date.parse("2026-03-25T12:00:00Z"),
      );
    }
    expect(readFile).not.toHaveBeenCalled();
    await disposeSessionSummaryIndex(config);
    expect((await listSessionSummaries(config, workspace))[1]?.sessionId).toBe("one");
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(String(readFile.mock.calls[0]?.[0])).toMatch(/session-summary-index\.json$/);
    expect(readdir).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("discovers each workspace once and shares concurrent initial discovery", async () => {
    const config = await createConfig();
    const index = await getSessionSummaryIndex(config);
    await index.ensureInitialized("empty");
    await disposeSessionSummaryIndex(config);
    const restored = await getSessionSummaryIndex(config);
    const readdir = vi.spyOn(fs, "readdir");
    await restored.ensureInitialized("empty");
    expect(readdir).not.toHaveBeenCalled();

    await writeSession(
      config,
      "new",
      "one.jsonl",
      "2026-03-25T12:00:00Z",
      [legacyHeader("one")],
      false,
    );
    const read = vi.spyOn(HarnessSessionStore, "read");
    await Promise.all([restored.ensureInitialized("new"), restored.ensureInitialized("new")]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(restored.list("new", "2026-03-25")[1]?.sessionId).toBe("one");
    await restored.ensureInitialized("new");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["malformed JSON", "{not JSON"],
    ["unsupported version", JSON.stringify({ version: 2, entries: {} })],
    ["invalid index structure", JSON.stringify({ version: 1, entries: {} })],
    [
      "invalid index structure",
      JSON.stringify({ version: 1, entries: { broken: null }, completedWorkspaces: [] }),
    ],
  ])("invalidates a %s cache and rebuilds it", async (_reason, content) => {
    const config = await createConfig();
    const workspace = workspaceInfo(config, "invalid-cache");
    await writeSession(
      config,
      workspace.id,
      "one.jsonl",
      "2026-03-25T12:00:00Z",
      [legacyHeader("one")],
      false,
    );
    const indexFile = path.join(battyAgentDir(config), "session-summary-index.json");
    await fs.mkdir(path.dirname(indexFile), { recursive: true });
    await fs.writeFile(indexFile, content);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const index = await getSessionSummaryIndex(config);
    expect(error).toHaveBeenCalledWith(
      "Invalid session summary index; rebuilding",
      expect.objectContaining({ file: indexFile, reason: _reason, error: expect.any(Error) }),
    );
    expect(await fs.readFile(indexFile, "utf8").catch(() => undefined)).toBeUndefined();
    expect(
      (await fs.readdir(path.dirname(indexFile))).some((file) =>
        file.startsWith("session-summary-index.json.invalid-"),
      ),
    ).toBe(true);
    await index.ensureInitialized(workspace.id);
    expect(index.list(workspace.id, "2026-03-25")[1]?.sessionId).toBe("one");
    await index.flush();
    expect(JSON.parse(await fs.readFile(indexFile, "utf8"))).toMatchObject({ version: 1 });
  });

  it("surfaces persistence failures and allows the next flush to save the index", async () => {
    const config = await createConfig();
    const workspace = workspaceInfo(config, "persistence");
    const index = await getSessionSummaryIndex(config);
    const store = await HarnessSessionStore.create(
      workspace.path,
      workspaceSessionDir(config, workspace.id),
    );
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("disk failure"));
    await expect(index.flush()).rejects.toThrow("disk failure");
    await expect(index.flush()).resolves.toBeUndefined();
    await store.native.close(BACKGROUND_CONTEXT);
    store.release();
    await disposeSessionSummaryIndex(config);
    expect((await listSessionSummaries(config, workspace))[1]?.sessionId).toBe(
      store.getSessionId(),
    );
  });

  it("does not let Pi repair a torn transcript during initial indexing", async () => {
    const config = await createConfig();
    const workspace = workspaceInfo(config, "torn");
    const store = await HarnessSessionStore.create(
      workspace.path,
      workspaceSessionDir(config, workspace.id),
    );
    const file = store.getSessionFile();
    await store.native.close(BACKGROUND_CONTEXT);
    store.release();
    const torn = `${await fs.readFile(file, "utf8")}{`;
    await fs.writeFile(file, torn);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const index = await getSessionSummaryIndex(config);
    await expect(index.ensureInitialized(workspace.id)).rejects.toThrow(
      "Session discovery is incomplete",
    );
    expect(errors).toHaveBeenCalledWith(
      "Failed to index session summary",
      expect.objectContaining({ file, error: expect.any(Error) }),
    );
    expect(await fs.readFile(file, "utf8")).toBe(torn);
  });

  it("prunes nested cron directories before traversal and isolates broken sessions", async () => {
    const config = await createConfig();
    const workspace = workspaceInfo(config, "pruning");
    await writeSession(
      config,
      workspace.id,
      "nested/cron/job/run/broken.jsonl",
      "2026-03-25T12:00:00Z",
      [],
      false,
    );
    await writeSession(
      config,
      workspace.id,
      "good.jsonl",
      "2026-03-25T12:00:00Z",
      [legacyHeader("good")],
      false,
    );
    const bad = await writeSession(
      config,
      workspace.id,
      "bad.jsonl",
      "2026-03-25T12:00:00Z",
      [],
      false,
    );
    const readdir = vi.spyOn(fs, "readdir");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const index = await getSessionSummaryIndex(config);
    await expect(index.ensureInitialized(workspace.id)).rejects.toThrow(
      "Session discovery is incomplete",
    );
    expect(
      readdir.mock.calls.every(
        ([directory]) => !String(directory).split(path.sep).includes("cron"),
      ),
    ).toBe(true);
    expect(error).toHaveBeenCalledWith(
      "Failed to index session summary",
      expect.objectContaining({ file: bad, error: expect.any(Error) }),
    );
    expect(index.list(workspace.id, "2026-03-25")[1]?.sessionId).toBe("good");
    readdir.mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));
    await expect(index.ensureInitialized("unreadable")).rejects.toThrow("denied");
  });

  it("updates create, messages, daily metadata, and hidden forks directly from Batty events", async () => {
    const config = await createConfig();
    const workspace = workspaceInfo(config, "events");
    const index = await getSessionSummaryIndex(config);
    const store = await HarnessSessionStore.create(
      workspace.path,
      workspaceSessionDir(config, workspace.id),
    );
    expect((await listSessionSummaries(config, workspace))[1]?.sessionId).toBe(
      store.getSessionId(),
    );
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const settings = SettingsManager.inMemory({ compaction: { enabled: false } });
    const resources = new DefaultResourceLoader({
      cwd: config.battyDir,
      agentDir: config.battyDir,
      noExtensions: true,
      noSkills: true,
      noThemes: true,
      noPromptTemplates: true,
    });
    const controller = await HarnessController.create(
      store,
      { models, model: faux.getModel() },
      settings,
      resources,
    );
    try {
      const read = vi.spyOn(HarnessSessionStore, "read");
      const readdir = vi.spyOn(fs, "readdir");
      await store.appendMessage({ role: "user", content: "live first message", timestamp: 100 });
      await store.appendMessage({ ...fauxAssistantMessage("reply"), timestamp: 200 });
      await store.appendCustomEntry(CRON_SESSION_CUSTOM_TYPE, {
        version: 1,
        kind: "daily",
        date: "2026-03-25",
      });
      const summary = index.list(workspace.id, "2026-03-25")[0];
      expect(summary).toMatchObject({
        sessionId: store.getSessionId(),
        firstMessage: "live first message",
        lastAssistantReplyAt: 200,
        dailySession: { isToday: true, exists: true },
      });
      expect(index.list(workspace.id, "2026-03-26")[1]?.dailySession?.isToday).toBe(false);
      const child = await store.fork(workspaceSessionDir(config, workspace.id));
      expect(index.list(workspace.id, "2026-03-25")).toHaveLength(1);
      await child.native.close(BACKGROUND_CONTEXT);
      child.release();
      expect(read).not.toHaveBeenCalled();
      expect(readdir).not.toHaveBeenCalled();
      await index.flush();
    } finally {
      await controller.dispose();
    }
    await disposeSessionSummaryIndex(config);
    expect(
      (await getSessionSummaryIndex(config)).list(workspace.id, "2026-03-25")[0]
        ?.lastAssistantReplyAt,
    ).toBe(200);
  });

  it("does not replace a live update with an older in-flight initial snapshot", async () => {
    const config = await createConfig();
    const workspace = workspaceInfo(config, "race");
    const store = await HarnessSessionStore.create(
      workspace.path,
      workspaceSessionDir(config, workspace.id),
    );
    const index = await getSessionSummaryIndex(config);
    const original = HarnessSessionStore.read.bind(HarnessSessionStore);
    vi.spyOn(HarnessSessionStore, "read").mockImplementationOnce(async (file, options) => {
      const stale = await original(file, options);
      store.observe({
        type: "message",
        id: "live",
        parentId: null,
        timestamp: 100,
        message: { role: "user", content: "new live message", timestamp: 100 },
      } as never);
      return stale;
    });
    await index.ensureInitialized(workspace.id);
    expect((await listSessionSummaries(config, workspace))[1]?.firstMessage).toBe(
      "new live message",
    );
    await store.native.close(BACKGROUND_CONTEXT);
    store.release();
  });

  it("does not replace writes received while loading the persisted index", async () => {
    const config = await createConfig();
    const workspace = workspaceInfo(config, "load-race");
    const index = await getSessionSummaryIndex(config);
    const store = await HarnessSessionStore.create(
      workspace.path,
      workspaceSessionDir(config, workspace.id),
    );
    await index.flush();
    await disposeSessionSummaryIndex(config);
    const original = fs.readFile.bind(fs);
    vi.spyOn(fs, "readFile").mockImplementationOnce(
      async (...args: Parameters<typeof fs.readFile>) => {
        const saved = await original(...args);
        store.observe({
          type: "message",
          id: "live",
          parentId: null,
          timestamp: 100,
          message: { role: "user", content: "during load", timestamp: 100 },
        } as never);
        return saved;
      },
    );
    const restored = await SessionSummaryIndex.create(config);
    expect(restored.list(workspace.id, "2026-03-25")[1]?.firstMessage).toBe("during load");
    await restored.dispose();
    await store.native.close(BACKGROUND_CONTEXT);
    store.release();
  });
});
