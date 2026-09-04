import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  ACTIVE_INTERACTIVE_TURN_JOURNAL_FILE_NAME,
  ActiveInteractiveTurnJournal,
  type PreparedInteractiveTurnSubmission,
} from "./active-interactive-turn-journal";

const tempDirs: string[] = [];

async function createBattyDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "batty-interactive-turn-journal-"));
  tempDirs.push(directory);
  return directory;
}

const firstSubmission: PreparedInteractiveTurnSubmission = {
  text: "hello",
  images: [{ type: "image", mimeType: "image/png", data: "abc" }],
  clientMessageId: "message-1",
  streamingBehavior: "steer",
};

const secondSubmission: PreparedInteractiveTurnSubmission = {
  text: "follow up",
  images: [],
  clientMessageId: "message-2",
  streamingBehavior: "followUp",
};

const initialEntry = {
  workspaceId: "workspace-1",
  sessionId: "session-1",
  sessionPath: "/tmp/session.jsonl",
  submissions: [{ ...firstSubmission, streamingBehavior: undefined }],
  startedAtMs: 123,
};

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("ActiveInteractiveTurnJournal", () => {
  it("starts empty when the journal file is missing and persists entries", async () => {
    const battyDir = await createBattyDir();
    const journal = await ActiveInteractiveTurnJournal.create(battyDir);

    expect(journal.list()).toEqual([]);
    expect(journal.get("session-1")).toBeUndefined();

    await journal.upsertInitialEntry(initialEntry);
    expect(journal.get("session-1")).toEqual(initialEntry);

    const restored = await ActiveInteractiveTurnJournal.create(battyDir);
    expect(restored.list()).toEqual([initialEntry]);
    expect(
      await fs.readFile(
        path.join(battyDir, ".batty", ACTIVE_INTERACTIVE_TURN_JOURNAL_FILE_NAME),
        "utf8",
      ),
    ).toContain('"version": 1');
  });

  it("appends prepared submissions, preserves order, and returns defensive copies", async () => {
    const journal = await ActiveInteractiveTurnJournal.create(await createBattyDir());
    await journal.upsertInitialEntry(initialEntry);
    await Promise.all([
      journal.appendQueuedSubmission("session-1", firstSubmission),
      journal.appendQueuedSubmission("session-1", secondSubmission),
    ]);

    const entry = journal.get("session-1");
    expect(entry?.submissions).toEqual([
      initialEntry.submissions[0],
      firstSubmission,
      secondSubmission,
    ]);
    if (entry) entry.submissions[0]!.text = "mutated";
    expect(journal.get("session-1")?.submissions[0]?.text).toBe("hello");

    const restored = await ActiveInteractiveTurnJournal.create(tempDirs[0] as string);
    expect(restored.get("session-1")?.submissions).toEqual([
      initialEntry.submissions[0],
      firstSubmission,
      secondSubmission,
    ]);
  });

  it("removes a submission by its client message id", async () => {
    const journal = await ActiveInteractiveTurnJournal.create(await createBattyDir());
    await journal.upsertInitialEntry(initialEntry);
    await journal.appendQueuedSubmission("session-1", secondSubmission);

    await journal.removeSubmission("session-1", secondSubmission.clientMessageId);

    expect(journal.get("session-1")?.submissions).toEqual(initialEntry.submissions);
  });

  it("upserts, deletes sessions, and serializes mutations", async () => {
    const journal = await ActiveInteractiveTurnJournal.create(await createBattyDir());
    await journal.upsertInitialEntry(initialEntry);
    await journal.upsertInitialEntry({ ...initialEntry, sessionId: "session-2", startedAtMs: 456 });
    await journal.deleteSession("session-1");
    expect(journal.list().map((entry) => entry.sessionId)).toEqual(["session-2"]);

    await journal.deleteSession("session-2");
    expect(journal.list()).toEqual([]);
    const restored = await ActiveInteractiveTurnJournal.create(tempDirs[0] as string);
    expect(restored.list()).toEqual([]);
  });

  it("rejects malformed, invalid-version, and structurally invalid files", async () => {
    const cases = [
      "not json",
      JSON.stringify({ version: 2, entries: {} }),
      JSON.stringify({ version: 1, entries: [] }),
      JSON.stringify({
        version: 1,
        entries: { "session-1": { ...initialEntry, submissions: undefined } },
      }),
    ];
    for (const content of cases) {
      const battyDir = await createBattyDir();
      const stateDir = path.join(battyDir, ".batty");
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(path.join(stateDir, ACTIVE_INTERACTIVE_TURN_JOURNAL_FILE_NAME), content);
      await expect(ActiveInteractiveTurnJournal.create(battyDir)).rejects.toThrow();
    }
  });

  it("rejects appending to an unknown session", async () => {
    const journal = await ActiveInteractiveTurnJournal.create(await createBattyDir());
    await expect(journal.appendQueuedSubmission("missing", firstSubmission)).rejects.toThrow(
      "No active interactive turn for session missing",
    );
  });
});
