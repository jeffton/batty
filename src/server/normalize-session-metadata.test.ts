import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { normalizeSessionMetadata } from "./normalize-session-metadata";

const roots: string[] = [];
const OLD_RESULT = "batty-agent-session-operation-result";
const COMPLETION = "batty-subagent-completion";
const MARKER = ".batty/session-metadata-normalization.json";
const date = "2026-09-30T00:00:00.000Z";
type RecordValue = Record<string, any>;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function root() {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), "batty-normalize-metadata-"));
  roots.push(value);
  return value;
}
function entry(id: string, parentId: string | null, customType: string, data: RecordValue) {
  return { type: "custom", id, parentId, timestamp: date, customType, data };
}
function message(id: string, parentId: string | null, content: any = id) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: date,
    message: { role: "user", content, timestamp: 1 },
  };
}
function receipt(
  id: string,
  parentId: string | null,
  fromTipId: string | null,
  tipId: string | null,
  extras: RecordValue = {},
) {
  return entry(id, parentId, OLD_RESULT, {
    operationId: id,
    kind: "run",
    status: "completed",
    fromTipId,
    tipId,
    startedAt: 1,
    endedAt: 2,
    ...extras,
  });
}
function migration(id: string, parentId: string | null, config = true) {
  return entry(id, parentId, "batty-agent-session-migration", {
    version: 1,
    sourceVersion: 4,
    originalTipId: parentId,
    branchTips: [{ branch: "main", tipId: parentId }],
    ...(config
      ? {
          configuration: {
            activeToolNames: ["read", "selected-tool"],
            model: { provider: "old-provider", modelId: "old-model" },
            thinkingLevel: "high",
          },
        }
      : {}),
  });
}
async function writeSession(root: string, entries: RecordValue[], name = "session", id = "child") {
  const file = path.join(root, ".batty", "sessions", "workspace", `${name}.jsonl`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const header = { type: "session", version: 3, id, timestamp: date, cwd: root };
  const content = `${[header, ...entries].map((value) => JSON.stringify(value)).join("\n")}\n`;
  await fs.writeFile(file, content);
  return { file, content };
}
async function read(file: string): Promise<RecordValue[]> {
  return (await fs.readFile(file, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

describe("offline native session metadata normalization", () => {
  it("preserves SDK context, tree, identities, selected leaf, model changes, and raw image lines", async () => {
    const directory = await root();
    const original = await writeSession(directory, [
      message("first", null),
      message("abandoned", "first"),
      message("selected", "first", [{ type: "image", data: "YWJj", mimeType: "image/png" }]),
      migration("prefs", "selected"),
      {
        type: "model_change",
        id: "model",
        parentId: "prefs",
        timestamp: date,
        provider: "new-provider",
        modelId: "new-model",
      },
      {
        type: "thinking_level_change",
        id: "thinking",
        parentId: "model",
        timestamp: date,
        thinkingLevel: "low",
      },
    ]);
    // Unaffected lines have intentionally noncanonical whitespace and CRLF endings.
    const raw = original.content
      .replace('"id":"selected"', '"id" : "selected"')
      .replaceAll("\n", "\r\n");
    await fs.writeFile(original.file, raw);
    const before = SessionManager.open(original.file);
    const context = before.buildSessionContext();
    const identities = before.getEntries().map(({ id, parentId }) => ({ id, parentId }));
    const summary = await normalizeSessionMetadata(directory);
    expect(summary).toMatchObject({ scanned: 1, convertedFiles: 1, tools: 1 });
    const after = SessionManager.open(original.file);
    expect(after.buildSessionContext()).toEqual(context);
    expect(after.getEntries().map(({ id, parentId }) => ({ id, parentId }))).toEqual(identities);
    expect(after.getLeafId()).toBe("thinking");
    expect(after.getBranch().map((item) => item.id)).toEqual(
      before.getBranch().map((item) => item.id),
    );
    const converted = await fs.readFile(original.file, "utf8");
    const previousLines = raw.split("\r\n");
    const nextLines = converted.split("\r\n");
    for (let index = 0; index < previousLines.length; index++) {
      if (index !== 4) expect(nextLines[index]).toBe(previousLines[index]);
    }
    expect((await read(original.file))[4]).toMatchObject({
      id: "prefs",
      parentId: "selected",
      timestamp: date,
      customType: "batty-session-tools",
      data: {
        activeToolNames: ["read", "selected-tool"],
        history: {
          originalTipId: "selected",
          branchTips: [{ branch: "main", tipId: "selected" }],
          sourceVersion: 4,
        },
      },
    });
    expect(
      await fs.readFile(path.join(summary.backupPath!, "workspace", "session.jsonl"), "utf8"),
    ).toBe(raw);
    expect(JSON.parse(await fs.readFile(path.join(directory, MARKER), "utf8"))).toMatchObject({
      version: 1,
      backupPath: summary.backupPath,
    });
    expect(await normalizeSessionMetadata(directory, { dryRun: true })).toMatchObject({
      alreadyNormalized: true,
      scanned: 0,
      dryRun: true,
    });
    // Without the deployment marker, normalized files still need no conversion or backup.
    await fs.unlink(path.join(directory, MARKER));
    expect(await normalizeSessionMetadata(directory, { dryRun: true })).toMatchObject({
      convertedFiles: 0,
      unchangedFiles: 1,
    });
    expect(await fs.readFile(original.file, "utf8")).toBe(converted);
  });

  it("retains provenance without manufacturing preferences when configuration is absent", async () => {
    const directory = await root();
    const { file } = await writeSession(directory, [migration("history", null, false)]);
    await normalizeSessionMetadata(directory);
    expect((await read(file))[1]).toEqual(
      entry("history", null, "batty-session-history", {
        originalTipId: null,
        branchTips: [{ branch: "main", tipId: null }],
        sourceVersion: 4,
      }),
    );
  });

  it.each(["completed", "declined", "failed", "aborted"])(
    "maps %s receipts by their actual end branch rather than appended receipt position",
    async (status) => {
      const directory = await root();
      const { file } = await writeSession(directory, [
        message("root", null),
        entry("own-child", "root", "batty-subagent-session", {
          sessionId: "child",
          parentSessionId: "parent",
        }),
        message("child-answer", "own-child"),
        entry("cron", "root", "batty-cron-run-session", {
          version: 1,
          kind: "run",
          jobId: "job",
          runId: "cron-receipt",
        }),
        message("cron-answer", "cron"),
        message("selected", "root"),
        receipt("child-receipt", "selected", "own-child", "child-answer", { status }),
        receipt("cron-receipt", "child-receipt", "cron", "cron-answer", {
          status,
          error: { code: "provider", message: "Provider detail" },
        }),
      ]);
      const summary = await normalizeSessionMetadata(directory);
      expect(summary).toMatchObject({ subagentResults: 1, cronResults: 1 });
      const values = await read(file);
      expect(values.find((value) => value.id === "child-receipt")).toMatchObject({
        customType: COMPLETION,
        data: {
          startEntryId: "own-child",
          endEntryId: "child-answer",
          status: status === "declined" ? "failed" : status,
          ...(status === "completed" ? {} : { error: `Subagent ${status}` }),
        },
      });
      expect(values.find((value) => value.id === "cron-receipt")).toMatchObject({
        customType: "batty-cron-execution",
        data: {
          runId: "cron-receipt",
          startEntryId: "cron",
          endEntryId: "cron-answer",
          status: status === "declined" ? "failed" : status,
          error: "Provider detail",
        },
      });
      expect(SessionManager.open(file).getLeafId()).toBe("cron-receipt");
    },
  );

  it("recognizes inline cron notices, but does not assign inherited parent markers to child runs", async () => {
    const directory = await root();
    const { file } = await writeSession(directory, [
      entry("parent-cron", null, "batty-cron-run-session", { runId: "parent-run" }),
      entry("copied-subagent", "parent-cron", "batty-subagent-session", { sessionId: "parent" }),
      message("copied-answer", "copied-subagent"),
      entry("own", "copied-answer", "batty-subagent-session", { sessionId: "child" }),
      message("answer", "own"),
      {
        type: "custom_message",
        id: "notice",
        parentId: "answer",
        timestamp: date,
        customType: "batty-runtime-notice:cron",
        content: "Scheduled work",
        display: true,
        details: { cron: { runId: "inline" } },
      },
      message("inline-answer", "notice"),
      receipt("parent-run", "inline-answer", "copied-subagent", "copied-answer"),
      receipt("child-run", "parent-run", "own", "answer"),
      receipt("inline", "child-run", "answer", "inline-answer"),
    ]);
    expect(await normalizeSessionMetadata(directory)).toMatchObject({
      operations: 1,
      subagentResults: 1,
      cronResults: 1,
    });
    const values = await read(file);
    expect(values.find((item) => item.id === "parent-run")?.customType).toBe(
      "batty-session-operation",
    );
    expect(values.find((item) => item.id === "child-run")?.customType).toBe(COMPLETION);
    expect(values.find((item) => item.id === "inline")?.customType).toBe("batty-cron-execution");
  });

  it("backfills all native completions, including following appended historical receipts", async () => {
    const directory = await root();
    const { file } = await writeSession(directory, [
      entry("own", null, "batty-subagent-session", { sessionId: "child" }),
      message("first-answer", "own"),
      entry("first-completion", "first-answer", COMPLETION, { status: "completed" }),
      message("old-answer", "first-completion"),
      receipt("old-completion", "old-answer", "first-completion", "old-answer"),
      message("new-answer", "old-completion"),
      entry("new-completion", "new-answer", COMPLETION, { status: "failed", error: "failure" }),
      entry("empty-completion", "new-completion", COMPLETION, { status: "completed" }),
    ]);
    expect(await normalizeSessionMetadata(directory)).toMatchObject({
      boundedCompletions: 3,
      subagentResults: 1,
    });
    const completions = (await read(file)).filter((item) => item.customType === COMPLETION);
    expect(
      completions.map((item) => [item.id, item.data.startEntryId, item.data.endEntryId]),
    ).toEqual([
      ["first-completion", "own", "first-answer"],
      ["old-completion", "first-completion", "old-answer"],
      ["new-completion", "old-completion", "new-answer"],
      ["empty-completion", "new-completion", "new-completion"],
    ]);
    await fs.unlink(path.join(directory, MARKER));
    expect(await normalizeSessionMetadata(directory, { dryRun: true })).toMatchObject({
      unchangedFiles: 1,
      convertedFiles: 0,
    });
  });

  it("preserves generic navigation across branches and compaction/run history with exact errors", async () => {
    const directory = await root();
    const { file } = await writeSession(directory, [
      message("first", null),
      message("left", "first"),
      message("right", "first"),
      receipt("navigation", "right", "left", "right", {
        kind: "navigation",
        status: "declined",
        error: { code: "declined", message: "No" },
      }),
      receipt("compaction", "navigation", "first", "right", { kind: "compaction" }),
      receipt("empty", "compaction", null, null),
    ]);
    expect(await normalizeSessionMetadata(directory)).toMatchObject({ operations: 3 });
    expect((await read(file)).find((item) => item.id === "navigation")).toEqual(
      entry("navigation", "right", "batty-session-operation", {
        operationId: "navigation",
        kind: "navigation",
        status: "declined",
        startEntryId: "left",
        endEntryId: "right",
        startedAt: 1,
        endedAt: 2,
        error: { code: "declined", message: "No" },
      }),
    );
  });

  it("preserves already-canonical interrupted cron running records", async () => {
    const directory = await root();
    const { file, content } = await writeSession(directory, [
      message("start", null),
      entry("running", "start", "batty-cron-execution", {
        runId: "run",
        startEntryId: "start",
        endEntryId: null,
        status: "running",
      }),
    ]);
    expect(await normalizeSessionMetadata(directory, { dryRun: true })).toMatchObject({
      unchangedFiles: 1,
    });
    expect(await fs.readFile(file, "utf8")).toBe(content);
  });

  it("aggregates validation failures across the entire dataset before creating backups or changing files", async () => {
    const directory = await root();
    const good = await writeSession(directory, [migration("prefs", null)], "a-good");
    const missing = await writeSession(
      directory,
      [receipt("missing", null, null, "absent")],
      "b-missing",
    );
    const invalid = await writeSession(
      directory,
      [message("left", null), message("right", null), receipt("result", "right", "left", "right")],
      "c-invalid",
    );
    await expect(normalizeSessionMetadata(directory)).rejects.toThrow(/2 file\(s\)/);
    try {
      await normalizeSessionMetadata(directory);
    } catch (error) {
      expect((error as AggregateError).errors.map((item) => item.message).join("\n")).toContain(
        missing.file,
      );
      expect((error as AggregateError).errors.map((item) => item.message).join("\n")).toContain(
        invalid.file,
      );
    }
    expect(await fs.readFile(good.file, "utf8")).toBe(good.content);
    expect(await fs.readdir(path.join(directory, ".batty"))).toEqual(["sessions"]);
  });

  it("leaves the marker absent on replacement failure and retries a partially normalized dataset", async () => {
    const directory = await root();
    const first = await writeSession(directory, [migration("prefs", null)], "a");
    const second = await writeSession(directory, [migration("prefs", null)], "b");
    const rename = fs.rename.bind(fs);
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
      if (target === second.file) throw new Error("simulated replacement failure");
      return rename(source, target);
    });
    await expect(normalizeSessionMetadata(directory)).rejects.toThrow(
      "simulated replacement failure",
    );
    expect((await read(first.file))[1]?.customType).toBe("batty-session-tools");
    expect(await fs.readFile(second.file, "utf8")).toBe(second.content);
    await expect(fs.stat(path.join(directory, MARKER))).rejects.toMatchObject({ code: "ENOENT" });
    spy.mockRestore();
    expect(await normalizeSessionMetadata(directory)).toMatchObject({
      convertedFiles: 1,
      unchangedFiles: 1,
    });
    expect(
      (await fs.readdir(path.join(directory, ".batty", "session-metadata-normalization-backups")))
        .length,
    ).toBe(2);
  });

  it("detects source changes during backup without replacing sessions or publishing a marker", async () => {
    const directory = await root();
    const session = await writeSession(directory, [migration("prefs", null)]);
    const copy = fs.copyFile.bind(fs);
    vi.spyOn(fs, "copyFile").mockImplementation(async (source, destination, mode) => {
      await copy(source, destination, mode);
      await fs.appendFile(source, "\n");
    });
    await expect(normalizeSessionMetadata(directory)).rejects.toThrow(
      "changed before metadata replacement",
    );
    expect(await fs.readFile(session.file, "utf8")).toBe(session.content + "\n");
    await expect(fs.stat(path.join(directory, MARKER))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not create files for a dry run or manufacture state for header-only sessions", async () => {
    const directory = await root();
    expect(await normalizeSessionMetadata(directory, { dryRun: true })).toMatchObject({
      scanned: 0,
      dryRun: true,
    });
    expect(await fs.readdir(directory)).toEqual([]);
    const { file, content } = await writeSession(directory, []);
    expect(await normalizeSessionMetadata(directory, { dryRun: true })).toMatchObject({
      scanned: 1,
      unchangedFiles: 1,
    });
    expect(await fs.readdir(path.join(directory, ".batty"))).toEqual(["sessions"]);
    expect(await normalizeSessionMetadata(directory)).toMatchObject({
      convertedFiles: 0,
      unchangedFiles: 1,
    });
    expect(await fs.readFile(file, "utf8")).toBe(content);
    expect(SessionManager.open(file).getEntries()).toEqual([]);
  });

  it("marks an empty installation complete and skips scanning a completed version", async () => {
    const directory = await root();
    await normalizeSessionMetadata(directory);
    await writeSession(directory, [{ type: "not-native" }]);
    expect(await normalizeSessionMetadata(directory, { dryRun: true })).toMatchObject({
      alreadyNormalized: true,
      scanned: 0,
    });
  });
});
