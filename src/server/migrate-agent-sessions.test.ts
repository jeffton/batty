import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { SessionManager, parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { migrateAgentSessions } from "./migrate-agent-sessions";
import { normalizeMessages, transcriptMessagesFromSessionEntries } from "./pi-state";
import { agentTurnArtifactsByReplyEntryId } from "./agent-turn-file-changes";

const roots: string[] = [];
const time = Date.parse("2026-09-30T00:00:00Z");
const configuration = {
  model: { provider: "test", modelId: "test-model" },
  thinkingLevel: "medium",
  activeToolNames: ["read", "codemode"],
};

async function fixture(records: unknown[], name = "session.jsonl") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-migration-"));
  roots.push(root);
  const file = path.join(root, ".batty", "sessions", "workspace", "nested", name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return { root, file };
}
function header(id = "session") {
  return { v: 4, kind: "header", storageVersion: 1, id, cwd: "/workspace", createdAt: time };
}
function entry(id: string, parentId: string | null, fields: Record<string, unknown>, seq: number) {
  return { kind: "entry", id, parentId, timestamp: time, seq, ...fields };
}
function value(namespace: string, key: string, value: unknown, seq: number) {
  return { kind: "value", op: "set", namespace, key, value, seq };
}
function config(tip: string | null, start: number) {
  return [
    value("pi.branch.tip", "main", tip, start),
    value("pi.lane.config", "main", configuration, start + 1),
  ];
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("migrateAgentSessions", () => {
  it("treats absent sessions as an empty dataset without creating directories", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-migration-empty-"));
    roots.push(root);
    for (const dryRun of [true, false]) {
      expect(await migrateAgentSessions(root, { dryRun })).toEqual({
        scanned: 0,
        migratedFiles: 0,
        unchanged: 0,
        entries: 0,
        images: 0,
        droppedExecutionWrites: 0,
        originalBytes: 0,
        convertedBytes: 0,
        largestConvertedFileBytes: 0,
        dryRun,
      });
      expect(await fs.readdir(root)).toEqual([]);
    }
    await fs.mkdir(path.join(root, ".batty"));
    expect(await migrateAgentSessions(root)).toMatchObject({ scanned: 0, migratedFiles: 0 });
    expect(await fs.readdir(path.join(root, ".batty"))).toEqual([]);
  });

  it("flushes backup contents and directories before replacements and target directories afterward", async () => {
    const { root, file } = await fixture([header(), ...config(null, 1)]);
    const events: Array<{ kind: "sync" | "rename"; path: string }> = [];
    const open = fs.open.bind(fs);
    const rename = fs.rename.bind(fs);
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        events.push({ kind: "sync", path: String(args[0]) });
        await sync();
      };
      return handle;
    });
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      events.push({ kind: "rename", path: String(destination) });
      await rename(source, destination);
    });
    try {
      const summary = await migrateAgentSessions(root);
      const renamedAt = events.findIndex((event) => event.kind === "rename");
      const backup = path.join(summary.backupPath!, "workspace", "nested", "session.jsonl");
      const before = events.slice(0, renamedAt).map((event) => event.path);
      expect(before).toContain(backup);
      if (process.platform !== "win32") {
        expect(before).toContain(path.dirname(backup));
        expect(before).toContain(summary.backupPath);
        expect(before).toContain(path.join(root, ".batty", "session-migration-backups"));
        expect(before).toContain(path.join(root, ".batty"));
        expect(events[renamedAt + 1]).toEqual({ kind: "sync", path: path.dirname(file) });
      }
    } finally {
      openSpy.mockRestore();
      renameSpy.mockRestore();
    }
  });

  it("preserves the selected tree, metadata, correlation, configuration, receipts and backups", async () => {
    const records = [
      header(),
      entry(
        "one",
        null,
        {
          type: "message",
          message: {
            role: "user",
            content: "hello",
            timestamp: time,
            userCorrelation: { id: "client" },
          },
        },
        1,
      ),
      entry(
        "two",
        "one",
        {
          type: "custom",
          customType: "batty-subagent-session",
          data: { parentSessionId: "parent" },
        },
        2,
      ),
      entry(
        "other",
        "one",
        { type: "message", message: { role: "user", content: "other branch", timestamp: time } },
        3,
      ),
      ...config("two", 4),
      value(
        "pi.result",
        "operation",
        { operationId: "operation", kind: "run", status: "completed", tipId: "two" },
        6,
      ),
      value(
        "pi.lane.state",
        "main",
        { currentOperationId: "stale", lastOperationId: null, inbox: [] },
        7,
      ),
    ];
    const { root, file } = await fixture(records);
    const original = await fs.readFile(file, "utf8");
    const summary = await migrateAgentSessions(root);
    expect(summary).toMatchObject({
      scanned: 1,
      migratedFiles: 1,
      unchanged: 0,
      entries: 3,
      droppedExecutionWrites: 1,
      dryRun: false,
    });
    expect(summary.backupPath).not.toContain(`${path.sep}sessions${path.sep}`);
    expect(
      await fs.readFile(
        path.join(summary.backupPath!, "workspace", "nested", "session.jsonl"),
        "utf8",
      ),
    ).toBe(original);
    const native = SessionManager.inMemory(
      undefined,
      undefined,
      parseSessionEntries(await fs.readFile(file, "utf8")),
    );
    expect(native.getSessionId()).toBe("session");
    expect(native.getEntries().find((entry) => entry.id === "one")).toMatchObject({
      message: { userCorrelation: { id: "client" } },
    });
    expect(native.getBranch().map((entry) => entry.id)).toContain("two");
    expect(native.getBranch().map((entry) => entry.id)).not.toContain("other");
    expect(native.buildSessionContext()).toMatchObject({
      model: configuration.model,
      thinkingLevel: "medium",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(native.getEntries()).toContainEqual(
      expect.objectContaining({
        customType: "batty-agent-session-operation-result",
        data: { operationId: "operation", kind: "run", status: "completed", tipId: "two" },
      }),
    );
    const second = await migrateAgentSessions(root);
    expect(second).toMatchObject({ migratedFiles: 0, unchanged: 1 });
    expect(second.backupPath).toBeUndefined();
  });

  it("preserves archived unset configuration without fabricating settings", async () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "Archived reply" }],
      timestamp: time,
      provider: "openai-codex",
      model: "gpt-5.4",
      stopReason: "stop",
    };
    const { root, file } = await fixture([
      header(),
      entry("reply", null, { type: "message", message }, 1),
      value("pi.branch.tip", "main", "reply", 2),
    ]);
    await migrateAgentSessions(root);
    const native = SessionManager.open(file);
    expect(
      native
        .getEntries()
        .some((entry) => entry.type === "model_change" || entry.type === "thinking_level_change"),
    ).toBe(false);
    const marker = native
      .getEntries()
      .find(
        (entry) => entry.type === "custom" && entry.customType === "batty-agent-session-migration",
      );
    expect(marker).toMatchObject({ data: { originalTipId: "reply" } });
    expect((marker as { data: Record<string, unknown> }).data).not.toHaveProperty("configuration");
    expect(native.buildSessionContext().model).toEqual({
      provider: "openai-codex",
      modelId: "gpt-5.4",
    });
  });

  it("preserves a header-only uninitialized session as an empty transcript", async () => {
    const { root, file } = await fixture([header()]);
    expect(await migrateAgentSessions(root)).toMatchObject({ migratedFiles: 1, entries: 0 });
    const native = SessionManager.open(file);
    expect(native.getSessionId()).toBe("session");
    expect(native.buildSessionContext().messages).toEqual([]);
    expect(native.buildSessionContext().model).toBeNull();
    expect(
      native
        .getEntries()
        .some((entry) => entry.type === "model_change" || entry.type === "thinking_level_change"),
    ).toBe(false);
  });

  it("rejects malformed explicit configuration", async () => {
    for (const configuration of [
      null,
      {},
      { model: { provider: "test", modelId: "model" }, thinkingLevel: "medium" },
    ]) {
      const { root } = await fixture([
        header(),
        value("pi.branch.tip", "main", null, 1),
        value("pi.lane.config", "main", configuration, 2),
      ]);
      await expect(migrateAgentSessions(root)).rejects.toThrow("Invalid main configuration");
    }
  });

  it("dry runs without creating files and leaves native sessions byte-for-byte unchanged", async () => {
    const { root, file } = await fixture([header(), ...config(null, 1)]);
    const native = path.join(path.dirname(file), "native.jsonl");
    const text = JSON.stringify({
      type: "session",
      version: 3,
      id: "native",
      timestamp: new Date(time).toISOString(),
      cwd: "/workspace",
    });
    await fs.writeFile(native, text);
    const before = await fs.readFile(file, "utf8");
    expect(await migrateAgentSessions(root, { dryRun: true })).toMatchObject({
      migratedFiles: 1,
      unchanged: 1,
      dryRun: true,
    });
    expect(await fs.readFile(file, "utf8")).toBe(before);
    expect(await fs.readFile(native, "utf8")).toBe(text);
    expect(await fs.readdir(path.join(root, ".batty"))).toEqual(["sessions"]);
  });

  it("prevalidates all sessions before backups or replacements", async () => {
    const { root, file } = await fixture([header(), ...config(null, 1)]);
    const original = await fs.readFile(file, "utf8");
    await fs.writeFile(
      path.join(path.dirname(file), "zzz.jsonl"),
      `${JSON.stringify(header("invalid"))}\n{bad}\n`,
    );
    await expect(migrateAgentSessions(root)).rejects.toThrow();
    expect(await fs.readFile(file, "utf8")).toBe(original);
    expect(await fs.readdir(path.join(root, ".batty"))).toEqual(["sessions"]);
  });

  it("hydrates images and maps native compactions and successful codemode branch stores", async () => {
    const bytes = Buffer.from("test image");
    const imageName = `${createHash("sha256").update(bytes).digest("hex")}.png`;
    const message = {
      role: "user",
      timestamp: time,
      content: [{ type: "image", mimeType: "image/png", data: `batty-file:${imageName}` }],
    };
    const result = {
      role: "toolResult",
      timestamp: time,
      toolName: "codemode",
      toolCallId: "call",
      content: [],
      isError: false,
      details: { codemode: { storeWrites: { set: { value: 42 }, delete: ["old"] } } },
    };
    const { root, file } = await fixture([
      header(),
      entry("prompt", null, { type: "message", message }, 1),
      entry("result", "prompt", { type: "message", message: result }, 2),
      entry(
        "compact",
        "result",
        {
          type: "compaction",
          summary: "summary",
          retainedTail: [message, result],
          tokensBefore: 100,
          fromHook: false,
        },
        3,
      ),
      ...config("compact", 4),
    ]);
    await fs.mkdir(`${file}.images`);
    await fs.writeFile(path.join(`${file}.images`, imageName), bytes);
    expect(await migrateAgentSessions(root)).toMatchObject({ images: 1, entries: 3 });
    const native = SessionManager.inMemory(
      undefined,
      undefined,
      parseSessionEntries(await fs.readFile(file, "utf8")),
    );
    expect(native.getEntries()).toContainEqual(
      expect.objectContaining({ id: "compact", firstKeptEntryId: "prompt" }),
    );
    expect(native.getBranch()).toContainEqual(
      expect.objectContaining({
        customType: "codemode-store",
        data: { set: { value: 42 }, delete: ["old"] },
      }),
    );
    expect(native.buildSessionContext().messages).toContainEqual({
      ...message,
      content: [{ type: "image", mimeType: "image/png", data: bytes.toString("base64") }],
    });
  });

  it("opens migrated runtime notices with UI metadata and child artifacts intact", async () => {
    const metadata = {
      subagent: { sessionId: "child", status: "completed" },
      battyFileChanges: [{ path: "/workspace/file.ts", before: "before", after: "after" }],
      sentFiles: [{ id: "file", name: "report.txt", path: "/report.txt" }],
      sites: [{ id: "site", name: "Report", url: "https://example.com" }],
    };
    const notice = {
      role: "custom",
      customType: "batty-runtime-notice:subagent",
      content: "Child finished",
      data: metadata,
      timestamp: time,
    };
    const hidden = {
      role: "custom",
      customType: "hidden",
      content: "Hidden notice",
      display: false,
      data: { cron: { jobId: "job" } },
      timestamp: time,
    };
    const reply = {
      role: "assistant",
      content: [{ type: "text", text: "Done" }],
      timestamp: time,
      provider: "test",
      model: "test-model",
      stopReason: "stop",
    };
    const { root, file } = await fixture([
      header(),
      entry("notice", null, { type: "message", message: notice }, 1),
      entry("hidden", "notice", { type: "message", message: hidden }, 2),
      entry("reply", "hidden", { type: "message", message: reply }, 3),
      entry(
        "compaction",
        "reply",
        {
          type: "compaction",
          summary: "summary",
          retainedTail: [notice, hidden, reply],
          tokensBefore: 100,
        },
        4,
      ),
      ...config("compaction", 5),
    ]);
    await migrateAgentSessions(root);
    const native = SessionManager.open(file);
    expect(native.getEntry("notice")).toMatchObject({
      type: "custom_message",
      id: "notice",
      parentId: null,
      customType: notice.customType,
      content: notice.content,
      display: true,
      details: metadata,
      timestamp: new Date(time).toISOString(),
    });
    expect(native.getEntry("hidden")).toMatchObject({
      type: "custom_message",
      display: false,
      details: hidden.data,
    });
    expect(native.getEntry("compaction")).toMatchObject({ firstKeptEntryId: "notice" });
    const entries = native.getEntries();
    const artifacts = agentTurnArtifactsByReplyEntryId(entries).get("reply");
    expect(artifacts).toMatchObject({
      sentFiles: metadata.sentFiles,
      sites: metadata.sites,
      fileChanges: [expect.objectContaining({ path: "/workspace/file.ts" })],
    });
    const messages = normalizeMessages(transcriptMessagesFromSessionEntries(entries));
    expect(messages).toContainEqual(
      expect.objectContaining({
        role: "custom",
        customType: notice.customType,
        text: "Child finished",
        data: metadata,
      }),
    );
    expect(
      messages.some((message) => message.role === "custom" && message.customType === "hidden"),
    ).toBe(false);
    expect(messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        sentFiles: metadata.sentFiles,
        sites: metadata.sites,
      }),
    );
  });

  it("fails on unsupported conversation, non-suffix compactions and pending inputs", async () => {
    for (const records of [
      [header(), entry("entry", null, { type: "unknown" }, 1), ...config("entry", 2)],
      [
        header(),
        entry(
          "entry",
          null,
          { type: "message", message: { role: "assistant", content: [], stopReason: "deferred" } },
          1,
        ),
        ...config("entry", 2),
      ],
      [
        header(),
        entry(
          "entry",
          null,
          {
            type: "compaction",
            summary: "summary",
            tokensBefore: 10,
            retainedTail: [{ role: "user", content: "missing" }],
          },
          1,
        ),
        ...config("entry", 2),
      ],
      [
        header(),
        ...config(null, 1),
        value(
          "pi.pending.entry",
          "pending",
          { type: "message", payload: { role: "user", content: "pending" } },
          3,
        ),
      ],
    ]) {
      const { root, file } = await fixture(records);
      const original = await fs.readFile(file, "utf8");
      await expect(migrateAgentSessions(root)).rejects.toThrow();
      expect(await fs.readFile(file, "utf8")).toBe(original);
    }
  });
});
