import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  ACTIVE_INTERACTIVE_TURN_FILE_NAME,
  ActiveInteractiveTurnJournal,
  type ActiveInteractiveTurn,
} from "./active-interactive-turn-journal";

const tempDirs: string[] = [];

async function createBattyDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "batty-interactive-turn-journal-"));
  tempDirs.push(directory);
  return directory;
}

const firstTurn: ActiveInteractiveTurn = {
  workspaceId: "workspace-1",
  sessionId: "session-1",
  sessionPath: "/tmp/session.jsonl",
};

const secondTurn: ActiveInteractiveTurn = {
  workspaceId: "workspace-2",
  sessionId: "session-2",
  sessionPath: "/tmp/session-2.jsonl",
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("ActiveInteractiveTurnJournal", () => {
  it("roundtrips active session markers", async () => {
    const battyDir = await createBattyDir();
    const journal = await ActiveInteractiveTurnJournal.create(battyDir);

    expect(journal.list()).toEqual([]);
    await journal.set(firstTurn);
    expect(journal.list()).toEqual([firstTurn]);

    const restored = await ActiveInteractiveTurnJournal.create(battyDir);
    expect(restored.list()).toEqual([firstTurn]);
    expect(
      await fs.readFile(path.join(battyDir, ".batty", ACTIVE_INTERACTIVE_TURN_FILE_NAME), "utf8"),
    ).toContain('"session-1"');
  });

  it("serializes concurrent mutations", async () => {
    const journal = await ActiveInteractiveTurnJournal.create(await createBattyDir());

    await Promise.all([
      journal.set(firstTurn),
      journal.set(secondTurn),
      journal.deleteSession(firstTurn.sessionId),
    ]);

    expect(journal.list()).toEqual([secondTurn]);
  });

  it("makes deleting a missing session harmless", async () => {
    const journal = await ActiveInteractiveTurnJournal.create(await createBattyDir());

    await expect(journal.deleteSession("missing")).resolves.toBeUndefined();
    expect(journal.list()).toEqual([]);
  });

  it("propagates malformed JSON errors", async () => {
    const battyDir = await createBattyDir();
    const stateDir = path.join(battyDir, ".batty");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(path.join(stateDir, ACTIVE_INTERACTIVE_TURN_FILE_NAME), "not json");

    await expect(ActiveInteractiveTurnJournal.create(battyDir)).rejects.toThrow(SyntaxError);
  });

  it("does not update memory after a failed write and recovers later", async () => {
    const journal = await ActiveInteractiveTurnJournal.create(await createBattyDir());
    vi.spyOn(fs, "writeFile").mockRejectedValueOnce(new Error("write failed"));

    await expect(journal.set(firstTurn)).rejects.toThrow("write failed");
    expect(journal.list()).toEqual([]);

    await journal.set(secondTurn);
    expect(journal.list()).toEqual([secondTurn]);
  });
});
