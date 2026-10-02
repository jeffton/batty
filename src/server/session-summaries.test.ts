import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createPiAgentSession } from "./pi-agent-session";
import type { AppConfig } from "@/server/config";
import {
  latestSessionUpdatedAt,
  listSessionSummaries,
  getSessionSummaryIndex,
  disposeSessionSummaryIndex,
  SessionSummaryIndex,
} from "@/server/session-summaries";
import { SessionStore } from "./session-store";
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
    sitesDir: path.join(root, "sites"),
    publicDir: path.join(root, "public"),
    webPushDir: path.join(root, "web-push"),
    webPushSubject: "mailto:test@example.com",
    cronDailySessionStartTime: "04:00",
    browserMaxTabs: 16,
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
  const header = entries.find((raw) => (raw as any).type === "session") as any;
  if (!header) {
    await fs.writeFile(sessionPath, "invalid sqlite session");
    return sessionPath;
  }
  const store = await SessionStore.create(
    workspaceInfo(config, workspaceId).path,
    path.dirname(sessionPath),
    header.parentSessionId,
    header.id,
  );
  for (const raw of entries) {
    const entry = raw as Record<string, any>;
    if (entry.type === "custom") {
      await store.appendCustomEntry(entry.customType, entry.data);
    } else if (entry.type === "custom_message") {
      await store.appendMessage({
        role: "custom",
        customType: entry.customType,
        content: entry.content,
        details: entry.details,
        display: entry.display,
        timestamp: Date.parse(updatedAt),
      });
    } else if (entry.type === "message") {
      const message = { timestamp: Date.parse(updatedAt), ...entry.message };
      await store.appendMessage(
        message.role === "assistant"
          ? {
              ...fauxAssistantMessage(message.content),
              ...message,
              content:
                typeof message.content === "string"
                  ? [{ type: "text", text: message.content }]
                  : message.content,
            }
          : message,
      );
    }
  }
  const createdPath = store.getSessionFile();
  await store.close();
  await fs.rename(createdPath, sessionPath);
  const date = new Date(updatedAt);
  await fs.utimes(sessionPath, date, date);
  if (resetIndex) {
    await disposeSessionSummaryIndex(config);
    await fs.rm(path.join(battyAgentDir(config), "session-summary-index.json"), { force: true });
  }
  return sessionPath;
}

describe("session summaries", () => {
  it("discovers only SQLite sessions and ignores legacy files and sidecars", async () => {
    const config = await createConfig();
    const workspace = workspaceInfo(config, "sqlite-only");
    const file = await writeSession(config, workspace.id, "modern.sqlite", "2026-03-25T12:00:00Z", [
      sessionHeader("modern"),
    ]);
    await fs.writeFile(path.join(path.dirname(file), "legacy.jsonl"), "invalid legacy transcript");
    await fs.writeFile(path.join(path.dirname(file), "sidecar.sqlite-wal"), "not a session");
    const read = vi.spyOn(SessionStore, "read");
    const sessions = await listSessionSummaries(config, workspace);
    expect(sessions.filter((session) => session.path).map((session) => session.sessionId)).toEqual([
      "modern",
    ]);
    expect(read.mock.calls.map(([path]) => path)).toEqual([file]);
  });
  it("lists sessions using file mtime and first user message", async () => {
    const config = await createConfig();
    const workspace = workspaceInfo(config, "alpha");
    await fs.mkdir(workspace.path, { recursive: true });

    const olderPath = await writeSession(
      config,
      workspace.id,
      "older.sqlite",
      "2026-03-24T12:00:00Z",
      [
        { type: "session", id: "older-id", timestamp: "2026-03-01T00:00:00Z" },
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
    await writeSession(config, workspace.id, "newer.sqlite", "2026-03-25T12:00:00Z", [
      { type: "session", id: "newer-id", timestamp: "2026-01-01T00:00:00Z" },
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
          id: path.join(workspaceSessionDir(config, workspace.id), "newer.sqlite"),
          sessionId: "newer-id",
          path: path.join(workspaceSessionDir(config, workspace.id), "newer.sqlite"),
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

    await writeSession(config, workspace.id, "empty.sqlite", "2026-03-25T12:00:00Z", [
      { type: "session", id: "empty-id", timestamp: "2026-01-01T00:00:00Z" },
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
      "subagent.sqlite",
      "2026-03-25T12:00:00Z",
      [
        { type: "session", id: "subagent-id", timestamp: "2026-03-25T12:00:00Z" },
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
      "cron-run.sqlite",
      "2026-03-25T12:00:00Z",
      [
        { type: "session", id: "cron-run-id", timestamp: "2026-03-25T12:00:00Z" },
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
      "cron/job-1/run-1/cron-run.sqlite",
      "2026-03-25T12:00:00Z",
      [
        { type: "session", id: "cron-run-id", timestamp: "2026-03-25T12:00:00Z" },
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
        id: "branched-subagent-id",
        timestamp: "2026-03-25T12:00:00Z",
        parentSessionId: "parent-id",
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
      "branched-subagent.sqlite",
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

    await writeSession(config, workspace.id, "older.sqlite", "2026-03-24T12:00:00Z", [
      { type: "session", id: "older-id", timestamp: "2026-03-24T12:00:00Z" },
      {
        type: "custom",
        customType: CRON_SESSION_CUSTOM_TYPE,
        data: { version: 1, kind: "daily", date: "2026-03-24" },
      },
    ]);
    const todayPath = await writeSession(
      config,
      workspace.id,
      "today.sqlite",
      "2026-03-20T12:00:00Z",
      [
        { type: "session", id: "today-id", timestamp: "2026-03-31T12:00:00Z" },
        {
          type: "custom",
          customType: CRON_SESSION_CUSTOM_TYPE,
          data: { version: 1, kind: "daily", date: "2026-03-31" },
        },
      ],
    );
    await writeSession(config, workspace.id, "newer.sqlite", "2026-03-25T12:00:00Z", [
      { type: "session", id: "newer-id", timestamp: "2026-03-25T12:00:00Z" },
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

    await writeSession(config, workspace.id, "regular.sqlite", "2026-03-25T12:00:00Z", [
      { type: "session", id: "regular-id", timestamp: "2026-03-25T12:00:00Z" },
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

    await writeSession(config, workspace.id, "older.sqlite", "2026-03-24T12:00:00Z", [
      { type: "session", id: "older-id", timestamp: "2026-03-30T12:00:00Z" },
    ]);
    await writeSession(config, workspace.id, "newer.sqlite", "2026-03-25T12:00:00Z", [
      { type: "session", id: "newer-id", timestamp: "2026-03-01T12:00:00Z" },
    ]);

    expect(await latestSessionUpdatedAt(config, workspace.id)).toBe(
      new Date("2026-03-25T12:00:00Z").getTime(),
    );
  });
});

const sessionHeader = (id: string) => ({
  type: "session",
  id,
  timestamp: "2026-03-25T12:00:00Z",
});

describe("persistent session summary index", () => {
  it("indexes committed durable turns and preserves their summaries across restart", async () => {
    const config = await createConfig();
    const workspace = workspaceInfo(config, "durable-turn");
    await fs.mkdir(workspace.path, { recursive: true });
    const faux = fauxProvider();
    const models = await ModelRuntime.create({
      modelsPath: null,
      authPath: path.join(config.battyDir, "auth.json"),
      refreshOnCreate: false,
    });
    models.registerNativeProvider(faux.provider);
    const index = await getSessionSummaryIndex(config);
    await index.ensureInitialized(workspace.id);
    const store = await SessionStore.create(
      workspace.path,
      workspaceSessionDir(config, workspace.id),
    );
    const { session } = await createPiAgentSession({
      config,
      workspace,
      sessionManager: store,
      modelRuntime: models,
      customTools: [],
      model: faux.getModel(),
      thinkingLevel: "off",
    });
    try {
      expect(index.list(workspace.id, "2026-10-02")[1]).toMatchObject({ messageCount: 0 });
      faux.setResponses([fauxAssistantMessage("Indexed answer")]);
      await session.prompt("Indexed question");
      expect(index.list(workspace.id, "2026-10-02")[1]).toMatchObject({
        firstMessage: "Indexed question",
        lastAssistantReplyAt: expect.any(Number),
      });
      await index.flush();
      await disposeSessionSummaryIndex(config);
      const restored = await getSessionSummaryIndex(config);
      await restored.ensureInitialized(workspace.id);
      expect(restored.list(workspace.id, "2026-10-02")[1]).toMatchObject({
        firstMessage: "Indexed question",
        lastAssistantReplyAt: expect.any(Number),
      });
    } finally {
      await session.dispose();
    }
  });

  it("rebuilds a fresh empty session from its durable header after clearing the index", async () => {
    const config = await createConfig();
    const workspace = workspaceInfo(config, "empty-rebuild");
    const index = await getSessionSummaryIndex(config);
    const store = await SessionStore.create(
      workspace.path,
      workspaceSessionDir(config, workspace.id),
    );
    const file = store.getSessionFile();
    const sessionId = store.getSessionId();
    expect(index.list(workspace.id, "2026-03-25")[1]?.sessionId).toBe(sessionId);
    await store.release();
    await disposeSessionSummaryIndex(config);
    await fs.rm(path.join(battyAgentDir(config), "session-summary-index.json"));
    const read = vi.spyOn(SessionStore, "read");
    const rebuilt = await getSessionSummaryIndex(config);
    await rebuilt.ensureInitialized(workspace.id);
    expect(read).toHaveBeenCalledWith(file, { readOnly: true });
    expect(rebuilt.list(workspace.id, "2026-03-25")[1]).toMatchObject({
      sessionId,
      path: file,
      firstMessage: "(no messages)",
      messageCount: 0,
    });
  });

  it("serves warm and restarted lists without directory scans, stats, or transcript reads", async () => {
    const config = await createConfig();
    const workspace = workspaceInfo(config, "warm");
    await writeSession(config, workspace.id, "one.sqlite", "2026-03-25T12:00:00Z", [
      sessionHeader("one"),
    ]);
    const index = await getSessionSummaryIndex(config);
    await index.ensureInitialized(workspace.id);
    await index.flush();
    const readdir = vi.spyOn(fs, "readdir");
    const stat = vi.spyOn(fs, "stat");
    const read = vi.spyOn(SessionStore, "read");
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
      "one.sqlite",
      "2026-03-25T12:00:00Z",
      [sessionHeader("one")],
      false,
    );
    const read = vi.spyOn(SessionStore, "read");
    await Promise.all([restored.ensureInitialized("new"), restored.ensureInitialized("new")]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(restored.list("new", "2026-03-25")[1]?.sessionId).toBe("one");
    await restored.ensureInitialized("new");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["malformed JSON", "{not JSON"],
    ["unsupported version", JSON.stringify({ version: 1, entries: {} })],
    ["invalid index structure", JSON.stringify({ version: 3, entries: {} })],
    [
      "invalid index structure",
      JSON.stringify({ version: 3, entries: { broken: null }, completedWorkspaces: [] }),
    ],
  ])("invalidates a %s cache and rebuilds it", async (_reason, content) => {
    const config = await createConfig();
    const workspace = workspaceInfo(config, "invalid-cache");
    await writeSession(
      config,
      workspace.id,
      "one.sqlite",
      "2026-03-25T12:00:00Z",
      [sessionHeader("one")],
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
    expect(JSON.parse(await fs.readFile(indexFile, "utf8"))).toMatchObject({ version: 3 });
  });

  it("surfaces persistence failures and allows the next flush to save the index", async () => {
    const config = await createConfig();
    const workspace = workspaceInfo(config, "persistence");
    const index = await getSessionSummaryIndex(config);
    const store = await SessionStore.create(
      workspace.path,
      workspaceSessionDir(config, workspace.id),
    );
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("disk failure"));
    await expect(index.flush()).rejects.toThrow("disk failure");
    await expect(index.flush()).resolves.toBeUndefined();
    await store.release();
    await disposeSessionSummaryIndex(config);
    expect((await listSessionSummaries(config, workspace))[1]?.sessionId).toBe(
      store.getSessionId(),
    );
  });

  it("reports a corrupt durable session without modifying it", async () => {
    const config = await createConfig();
    const workspace = workspaceInfo(config, "torn");
    const store = await SessionStore.create(
      workspace.path,
      workspaceSessionDir(config, workspace.id),
    );
    await store.appendMessage({ role: "user", content: "initial", timestamp: 1 });
    const file = store.getSessionFile();
    await store.release();
    const torn = "invalid sqlite database";
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
      "nested/cron/job/run/broken.sqlite",
      "2026-03-25T12:00:00Z",
      [],
      false,
    );
    await writeSession(
      config,
      workspace.id,
      "good.sqlite",
      "2026-03-25T12:00:00Z",
      [sessionHeader("good")],
      false,
    );
    const bad = await writeSession(
      config,
      workspace.id,
      "bad.sqlite",
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
    const store = await SessionStore.create(
      workspace.path,
      workspaceSessionDir(config, workspace.id),
    );
    expect((await listSessionSummaries(config, workspace))[1]?.sessionId).toBe(
      store.getSessionId(),
    );
    const read = vi.spyOn(SessionStore, "read");
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
    await child.release();
    expect(read).not.toHaveBeenCalled();
    expect(readdir).not.toHaveBeenCalled();
    await index.flush();
    await store.release();
    await disposeSessionSummaryIndex(config);
    expect(
      (await getSessionSummaryIndex(config)).list(workspace.id, "2026-03-25")[0]
        ?.lastAssistantReplyAt,
    ).toBe(200);
  });

  it("does not replace a live update with an older in-flight initial snapshot", async () => {
    const config = await createConfig();
    const workspace = workspaceInfo(config, "race");
    const store = await SessionStore.create(
      workspace.path,
      workspaceSessionDir(config, workspace.id),
    );
    await store.appendCustomEntry("test", {});
    // Include a persisted conversation message in the initial snapshot.
    await store.appendMessage({
      ...fauxAssistantMessage("setup"),
      timestamp: 1,
    });
    const index = await getSessionSummaryIndex(config);
    const original = SessionStore.read.bind(SessionStore);
    vi.spyOn(SessionStore, "read").mockImplementationOnce(async (file, options) => {
      const stale = await original(file, options);
      await store.appendMessage({ role: "user", content: "new live message", timestamp: 100 });
      return stale;
    });
    await index.ensureInitialized(workspace.id);
    expect((await listSessionSummaries(config, workspace))[1]?.firstMessage).toBe(
      "new live message",
    );
    await store.release();
  });

  it("does not replace writes received while loading the persisted index", async () => {
    const config = await createConfig();
    const workspace = workspaceInfo(config, "load-race");
    const index = await getSessionSummaryIndex(config);
    const store = await SessionStore.create(
      workspace.path,
      workspaceSessionDir(config, workspace.id),
    );
    await index.flush();
    await disposeSessionSummaryIndex(config);
    const original = fs.readFile.bind(fs);
    vi.spyOn(fs, "readFile").mockImplementationOnce(
      async (...args: Parameters<typeof fs.readFile>) => {
        const saved = await original(...args);
        await store.appendMessage({ role: "user", content: "during load", timestamp: 100 });
        return saved;
      },
    );
    const restored = await SessionSummaryIndex.create(config);
    expect(restored.list(workspace.id, "2026-03-25")[1]?.firstMessage).toBe("during load");
    await restored.dispose();
    await store.release();
  });
});
