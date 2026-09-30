import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SessionStore } from "./session-store";

const roots: string[] = [];
const stores: SessionStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.release();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function session() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-session-store-"));
  roots.push(root);
  const store = await SessionStore.create(root, path.join(root, "sessions"));
  stores.push(store);
  await store.appendMessage({ role: "user", content: "hello", timestamp: 1 });
  return store;
}

describe("SessionStore", () => {
  it("does not expose the SDK's implicit off value as a stored thinking preference", async () => {
    const store = await session();
    expect((await store.configuration()).thinkingLevel).toBeUndefined();
    await store.appendCustomEntry("batty-session-tools", { activeToolNames: ["read"] });
    expect((await store.configuration()).thinkingLevel).toBeUndefined();
    store.native.appendModelChange("faux", "faux-1");
    expect((await store.configuration()).thinkingLevel).toBeUndefined();
    const selected = store.getLeafId();
    store.native.appendThinkingLevelChange("high");
    expect((await store.configuration()).thinkingLevel).toBe("high");
    store.native.branch(selected!);
    expect((await store.configuration()).thinkingLevel).toBeUndefined();
  });

  it.each(["high", "off"] as const)(
    "projects tools and explicit native %s thinking independently of model metadata",
    async (thinkingLevel) => {
      const store = await session();
      store.native.appendThinkingLevelChange(thinkingLevel);
      await store.appendCustomEntry("batty-session-tools", { activeToolNames: ["selected-tool"] });
      store.release();
      const reopened = await SessionStore.open(store.getSessionFile());
      stores.push(reopened);
      expect(await reopened.configuration()).toEqual({
        model: undefined,
        thinkingLevel,
        activeToolNames: ["selected-tool"],
      });
    },
  );

  it("projects canonical tool preferences from the selected branch with native model settings", async () => {
    const store = await session();
    store.native.appendModelChange("faux", "faux-1");
    store.native.appendThinkingLevelChange("high");
    await store.appendCustomEntry("batty-session-tools", { activeToolNames: ["read"] });
    const selected = store.getLeafId();
    await store.appendCustomEntry("batty-session-tools", { activeToolNames: ["write"] });
    store.native.branch(selected!);
    await store.appendMessage({ role: "user", content: "selected", timestamp: 2 });
    store.release();
    const reopened = await SessionStore.open(store.getSessionFile());
    stores.push(reopened);
    expect(await reopened.configuration()).toEqual({
      model: { provider: "faux", modelId: "faux-1" },
      thinkingLevel: "high",
      activeToolNames: ["read"],
    });
  });

  it("persists a fresh empty session that can be found and reopened", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-empty-session-"));
    roots.push(root);
    const sessionDir = path.join(root, "sessions");
    const store = await SessionStore.create(root, sessionDir);
    stores.push(store);
    const file = store.getSessionFile();
    const id = store.getSessionId();
    expect(JSON.parse((await fs.readFile(file, "utf8")).trim())).toMatchObject({
      type: "session",
      version: 3,
      id,
    });
    store.release();
    const snapshot = await SessionStore.read(file, { readOnly: true });
    expect(snapshot.entries).toEqual([]);
    const reopened = await SessionStore.existing(root, sessionDir, id);
    stores.push(reopened!);
    expect(reopened?.getSessionFile()).toBe(file);
    expect(reopened?.getEntries()).toEqual([]);
  });

  it("forks a past leaf without later messages or abandoned branches", async () => {
    const store = await session();
    const firstId = store.getLeafId()!;
    const abandonedId = await store.appendMessage({
      role: "user",
      content: "abandoned",
      timestamp: 2,
    });
    store.native.branch(firstId);
    const selectedId = await store.appendMessage({
      role: "user",
      content: "selected",
      timestamp: 3,
    });
    await store.appendMessage({ role: "user", content: "future", timestamp: 4 });
    const originalEntries = store.getEntries();
    const originalLeaf = store.getLeafId();
    const forkId = randomUUID();
    const fork = await store.fork(path.join(store.native.getCwd(), "fork"), selectedId, forkId);
    stores.push(fork);
    expect(fork.getSessionId()).toBe(forkId);
    expect(fork.getEntries().map((entry) => entry.id)).toEqual([firstId, selectedId]);
    expect(fork.getEntries().some((entry) => entry.id === abandonedId)).toBe(false);
    expect(fork.getLeafId()).toBe(selectedId);
    expect(fork.native.getHeader()?.parentSession).toBe(store.getSessionFile());
    expect(store.getEntries()).toEqual(originalEntries);
    expect(store.getLeafId()).toBe(originalLeaf);
    fork.release();
    const reopened = await SessionStore.open(fork.getSessionFile());
    stores.push(reopened);
    expect(reopened.getEntries()).toEqual(fork.getEntries());
    expect(reopened.getLeafId()).toBe(selectedId);
  });

  it("forks only the active branch when no leaf is specified", async () => {
    const store = await session();
    const firstId = store.getLeafId()!;
    await store.appendMessage({ role: "user", content: "abandoned", timestamp: 2 });
    store.native.branch(firstId);
    const activeId = await store.appendMessage({ role: "user", content: "active", timestamp: 3 });
    const fork = await store.fork(path.join(store.native.getCwd(), "active-fork"));
    stores.push(fork);
    expect(fork.getEntries().map((entry) => entry.id)).toEqual([firstId, activeId]);
  });

  it("forks an explicitly empty history", async () => {
    const store = await session();
    const fork = await store.fork(path.join(store.native.getCwd(), "empty-fork"), null);
    stores.push(fork);
    expect(fork.getEntries()).toEqual([]);
    expect(fork.getLeafId()).toBeNull();
    expect(fork.native.getHeader()?.parentSession).toBe(store.getSessionFile());
    fork.release();
    const reopened = await SessionStore.open(fork.getSessionFile());
    stores.push(reopened);
    expect(reopened.getEntries()).toEqual([]);
  });

  it("shares concurrent opens and delegates tree state to the native SDK", async () => {
    const store = await session();
    const file = store.getSessionFile();
    store.release();
    const [first, second] = await Promise.all([SessionStore.open(file), SessionStore.open(file)]);
    stores.push(first);
    expect(first).toBe(second);
    expect(first.native).toBeInstanceOf(SessionManager);
    expect(first.getEntries()).toEqual(first.native.getEntries());
    expect(first.getBranch()).toEqual(first.native.getBranch());
    expect(first.getLeafId()).toBe(first.native.getLeafId());
  });

  it("reads without repairing torn transcripts", async () => {
    const store = await session();
    const file = store.getSessionFile();
    store.release();
    const malformed = `${await fs.readFile(file, "utf8")}{`;
    await fs.writeFile(file, malformed);
    await expect(SessionStore.read(file, { readOnly: true })).rejects.toThrow();
    expect(await fs.readFile(file, "utf8")).toBe(malformed);
  });

  it("refuses Harness v4 without modifying its file", async () => {
    const store = await session();
    const file = store.getSessionFile();
    store.release();
    const old = `${JSON.stringify({ v: 4, kind: "header", id: "old", storageVersion: 1 })}\n`;
    await fs.writeFile(file, old);
    await expect(SessionStore.open(file)).rejects.toThrow("Expected Pi session version 3");
    await expect(SessionStore.read(file, { readOnly: true })).rejects.toThrow(
      "Expected Pi session version 3",
    );
    expect(await fs.readFile(file, "utf8")).toBe(old);
  });

  it("publishes direct app writes and SDK writes on request", async () => {
    const store = await session();
    const snapshots: unknown[] = [];
    const unsubscribe = SessionStore.subscribe((_file, snapshot) => snapshots.push(snapshot));
    try {
      await store.appendCustomEntry("batty:test", { value: 1 });
      store.native.appendModelChange("test", "model");
      store.native.appendThinkingLevelChange("high");
      store.publishSummary();
      expect(snapshots).toHaveLength(2);
      expect(snapshots[1]).toMatchObject({ entries: store.native.getEntries() });
      expect(await store.configuration()).toMatchObject({ thinkingLevel: "high" });
    } finally {
      unsubscribe();
    }
  });
});
