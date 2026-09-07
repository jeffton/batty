import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { HarnessSessionStore } from "./harness-session-store";
import { createHarnessFixture } from "./harness-test-fixture";
import { agentTurnFileChangesByReplyEntryId } from "./agent-turn-file-changes";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const timestamp = new Date(1).toISOString();

async function legacyFile() {
  const f = await createHarnessFixture();
  cleanups.push(f.cleanup);
  const file = path.join(f.root, "legacy.jsonl");
  const entries = [
    {
      type: "session",
      version: 3,
      id: "11111111-1111-4111-8111-111111111111",
      cwd: f.root,
      timestamp,
    },
    {
      type: "model_change",
      id: "00000001",
      parentId: null,
      provider: "faux",
      modelId: "faux-1",
      timestamp,
    },
    {
      type: "thinking_level_change",
      id: "00000002",
      parentId: "00000001",
      thinkingLevel: "off",
      timestamp,
    },
    {
      type: "message",
      id: "00000003",
      parentId: "00000002",
      timestamp,
      message: { role: "user", content: "work", timestamp: 1, clientMessageId: "client-legacy" },
    },
    {
      type: "message",
      id: "00000004",
      parentId: "00000003",
      timestamp,
      message: fauxAssistantMessage("done"),
    },
    {
      type: "custom",
      id: "00000005",
      parentId: "00000004",
      timestamp,
      customType: "batty-agent-turn-file-changes",
      data: {
        version: 1,
        replyEntryId: "00000004",
        files: [{ path: "/file", patch: "legacy patch" }],
      },
    },
    {
      type: "session_info",
      id: "00000006",
      parentId: "00000005",
      timestamp,
      name: "Imported title",
    },
  ];
  await fs.writeFile(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return { f, file };
}
function retain(store: HarnessSessionStore) {
  cleanups.push(async () => {
    await store.native.close(context);
    store.release();
  });
  return store;
}

describe("native harness session storage", () => {
  it("uses Pi's v3 importer and keeps Batty reply metadata valid across reminting, reopen, and fork", async () => {
    const { f, file } = await legacyFile();
    const store = retain(await HarnessSessionStore.open(file));
    const assistant = store
      .getBranch()
      .find((entry) => entry.type === "message" && entry.message.role === "assistant")!;
    expect(assistant.id).not.toBe("00000004");
    expect(store.getBranch()).toContainEqual(
      expect.objectContaining({
        message: expect.objectContaining({ clientMessageId: "client-legacy" }),
      }),
    );
    expect(agentTurnFileChangesByReplyEntryId(store.getEntries()).get(assistant.id)).toEqual([
      { path: "/file", patch: "legacy patch" },
    ]);
    expect(JSON.parse((await fs.readFile(file, "utf8")).split("\n")[0]!)).toMatchObject({
      kind: "header",
      v: 4,
    });
    await store.native.close(context);
    store.release();
    const reopened = retain(await HarnessSessionStore.open(file));
    expect(
      reopened
        .getBranch()
        .find((entry) => entry.type === "message" && entry.message.role === "assistant")!.id,
    ).toBe(assistant.id);
    expect(
      agentTurnFileChangesByReplyEntryId(reopened.getEntries()).get(assistant.id)?.[0]?.patch,
    ).toBe("legacy patch");
    const child = retain(await reopened.fork(path.join(f.root, "children")));
    expect(
      agentTurnFileChangesByReplyEntryId(child.getEntries()).get(assistant.id)?.[0]?.patch,
    ).toBe("legacy patch");
    expect(child.native.metadata.parentSessionId).toBe(reopened.getSessionId());
  });

  it("reads and imports legacy sessions with blank lines without losing entries", async () => {
    const { file } = await legacyFile();
    const original = await fs.readFile(file, "utf8");
    const spaced = original.replaceAll("\n", "\n \t\n\n");
    await fs.writeFile(file, spaced);
    const summary = await HarnessSessionStore.read(file);
    expect(summary.entries).toHaveLength(3);
    expect(await fs.readFile(file, "utf8")).toBe(spaced);
    const store = retain(await HarnessSessionStore.open(file));
    expect(store.getEntries()).toHaveLength(3);
    const assistant = store
      .getBranch()
      .find((entry) => entry.type === "message" && entry.message.role === "assistant")!;
    expect(agentTurnFileChangesByReplyEntryId(store.getEntries()).get(assistant.id)).toEqual([
      { path: "/file", patch: "legacy patch" },
    ]);
  });

  it("keeps physical line numbers in legacy parse errors after blank lines", async () => {
    const { file } = await legacyFile();
    await fs.appendFile(file, "\n \t\n{not json}\n");
    const before = await fs.readFile(file, "utf8");
    await expect(HarnessSessionStore.read(file)).rejects.toThrow("line 10");
    await expect(HarnessSessionStore.open(file)).rejects.toThrow("line 10");
    expect(await fs.readFile(file, "utf8")).toBe(before);
  });

  it("coalesces concurrent opens into one native writer", async () => {
    const { file } = await legacyFile();
    const stores = await Promise.all([
      HarnessSessionStore.open(file),
      HarnessSessionStore.open(file),
    ]);
    retain(stores[0]!);
    expect(stores[0]).toBe(stores[1]);
  });

  it("surfaces malformed storage without rewriting it", async () => {
    const { file } = await legacyFile();
    await fs.appendFile(file, "{not json}\n");
    const before = await fs.readFile(file, "utf8");
    await expect(HarnessSessionStore.open(file)).rejects.toThrow();
    expect(await fs.readFile(file, "utf8")).toBe(before);
  });
});
