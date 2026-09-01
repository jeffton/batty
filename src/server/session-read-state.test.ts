import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { SessionReadStateStore } from "./session-read-state";

const tempDirs: string[] = [];

async function createBattyDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "batty-read-state-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true })));
});

describe("SessionReadStateStore", () => {
  it("marks the initial session baseline as read exactly once", async () => {
    const battyDir = await createBattyDir();
    const store = await SessionReadStateStore.create(battyDir);

    await store.initializeBaseline([
      { sessionId: "old-session", lastAssistantReplyAt: 100 },
      { sessionId: "empty-session" },
    ]);
    expect(store.hasUnread("old-session", 100)).toBe(false);
    expect(store.hasUnread("old-session", 101)).toBe(true);

    const restored = await SessionReadStateStore.create(battyDir);
    await restored.initializeBaseline([{ sessionId: "old-session", lastAssistantReplyAt: 200 }]);
    expect(restored.hasUnread("old-session", 200)).toBe(true);
  });

  it("migrates the original read-state format while baselining old sessions", async () => {
    const battyDir = await createBattyDir();
    const stateDir = path.join(battyDir, ".batty");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, "session-read-state.json"),
      `${JSON.stringify({ "already-read": 50 })}\n`,
    );

    const store = await SessionReadStateStore.create(battyDir);
    await store.initializeBaseline([
      { sessionId: "already-read", lastAssistantReplyAt: 100 },
      { sessionId: "old-session", lastAssistantReplyAt: 75 },
    ]);

    expect(store.hasUnread("already-read", 100)).toBe(false);
    expect(store.hasUnread("old-session", 75)).toBe(false);
  });

  it("persists read positions and reports newer assistant replies as unread", async () => {
    const battyDir = await createBattyDir();
    const store = await SessionReadStateStore.create(battyDir);

    expect(store.hasUnread("session-1", 100)).toBe(true);
    await store.markRead("session-1", 100);
    expect(store.hasUnread("session-1", 100)).toBe(false);
    expect(store.hasUnread("session-1", 101)).toBe(true);

    const restored = await SessionReadStateStore.create(battyDir);
    expect(restored.hasUnread("session-1", 100)).toBe(false);
    expect(restored.hasUnread("session-1", 101)).toBe(true);
  });
});
