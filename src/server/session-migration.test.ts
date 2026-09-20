import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { migrateLegacySessions } from "./session-migration";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function createLegacySession(): Promise<{ root: string; file: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-session-migration-"));
  roots.push(root);
  const directory = path.join(root, ".batty", "sessions", "workspace", "cron", "job", "run");
  const file = path.join(directory, "legacy.jsonl");
  const timestamp = new Date(1).toISOString();
  const entries = [
    {
      type: "session",
      version: 3,
      id: "11111111-1111-4111-8111-111111111111",
      cwd: root,
      timestamp,
    },
    {
      type: "model_change",
      id: "model",
      parentId: null,
      provider: "faux",
      modelId: "faux-1",
      timestamp,
    },
    {
      type: "thinking_level_change",
      id: "thinking",
      parentId: "model",
      thinkingLevel: "off",
      timestamp,
    },
    {
      type: "message",
      id: "user",
      parentId: "thinking",
      timestamp,
      message: {
        role: "user",
        content: [
          { type: "text", text: "work" },
          { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
        ],
        timestamp: 1,
      },
    },
    {
      type: "message",
      id: "reply",
      parentId: "user",
      timestamp,
      message: fauxAssistantMessage("done"),
    },
    {
      type: "custom",
      id: "changes",
      parentId: "reply",
      timestamp,
      customType: "batty-agent-turn-file-changes",
      data: { version: 1, replyEntryId: "reply", files: [] },
    },
  ];
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return { root, file };
}

function flattenedRecords(text: string): Array<Record<string, unknown>> {
  return text
    .trimEnd()
    .split("\n")
    .flatMap((line) => {
      const value = JSON.parse(line);
      return (Array.isArray(value) ? value : [value]) as Array<Record<string, unknown>>;
    });
}

describe("legacy session migration", () => {
  it("recursively migrates sessions and persists remapped Batty references", async () => {
    const { root, file } = await createLegacySession();
    await fs.chmod(file, 0o640);

    await expect(migrateLegacySessions(root)).resolves.toEqual({
      scanned: 1,
      migrated: 1,
      repaired: 1,
    });

    const stored = await fs.readFile(file, "utf8");
    if (process.platform !== "win32") expect((await fs.stat(file)).mode & 0o777).toBe(0o640);
    const records = flattenedRecords(stored);
    expect(records[0]).toMatchObject({ v: 4, kind: "header" });
    expect(stored).toContain("batty-file:");
    expect(stored).not.toContain("aGVsbG8=");
    const reply = records.find(
      (record) =>
        record.kind === "entry" &&
        record.type === "message" &&
        (record.message as { role?: string }).role === "assistant",
    )!;
    const changes = records.find(
      (record) => record.kind === "entry" && record.customType === "batty-agent-turn-file-changes",
    )!;
    expect(changes.data).toMatchObject({ replyEntryId: reply.id });

    await expect(migrateLegacySessions(root)).resolves.toEqual({
      scanned: 1,
      migrated: 0,
      repaired: 0,
    });
  });

  it("leaves malformed legacy sessions untouched and fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-session-migration-"));
    roots.push(root);
    const directory = path.join(root, ".batty", "sessions", "workspace");
    const file = path.join(directory, "broken.jsonl");
    const original = "{not json}\n";
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(file, original);

    await expect(migrateLegacySessions(root)).rejects.toThrow();
    await expect(fs.readFile(file, "utf8")).resolves.toBe(original);
  });
});
