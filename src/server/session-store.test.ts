import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc } from "@earendil-works/pi-durable";
import lockfile from "proper-lockfile";
import { SessionStore } from "./session-store";
import { SESSION_TOOLS_CUSTOM_TYPE } from "./session-metadata";

const context = BACKGROUND_CONTEXT;
const roots: string[] = [];
const stores: SessionStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function session(empty = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-session-store-"));
  roots.push(root);
  const store = await SessionStore.create(root, path.join(root, "sessions"));
  stores.push(store);
  if (!empty) await store.appendMessage({ role: "user", content: "hello", timestamp: 1 });
  return store;
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("SessionStore durable SQLite ownership", () => {
  it("adopts committed entries and submission identities before observers without rescanning history", async () => {
    const store = await session(true);
    const entries = vi.spyOn(store.conversation, "entries");
    const submissions = vi.spyOn(store.storage, "scanSubmissions");
    let observed: ReturnType<SessionStore["getEntries"]> = [];
    const unsubscribe = store.harness.subscribeCommits(() => {
      observed = store.getEntries();
    });
    const id = await store.conversation.commit(async (tx) => {
      await tx.conversation(store.conversation.id);
      const submission = await tx.createSubmission({
        conversationId: store.conversation.id,
        type: "input",
        status: "queued",
        requestId: "client:committed-id",
      });
      const entry = await tx.appendEntry(store.conversation.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "Committed", timestamp: 1 }],
      });
      tx.placeSubmission(submission.id, entry.id);
      tx.settleSubmission(submission.id, { status: "done", answer: entry.id });
      return submission.id;
    }, context);
    unsubscribe();
    expect(observed).toMatchObject([
      { type: "message", message: { role: "user", clientMessageId: "committed-id" } },
    ]);
    expect(store.getSubmissionRecord(id)).toMatchObject({
      status: "done",
      requestId: "client:committed-id",
    });
    await store.refresh();
    expect(entries).not.toHaveBeenCalled();
    expect(submissions).not.toHaveBeenCalled();
  });

  it("closes temporary source writers after successful and failing callbacks", async () => {
    const store = await session();
    const file = store.getSessionFile();
    await store.close();
    const entries = await SessionStore.withSource(file, async (source) => {
      expect(await lockfile.check(file)).toBe(true);
      return source.getEntries();
    });
    expect(entries).toEqual(store.getEntries());
    expect(await lockfile.check(file)).toBe(false);
    await expect(
      SessionStore.withSource(file, async () => {
        throw new Error("copy failed");
      }),
    ).rejects.toThrow("copy failed");
    expect(await lockfile.check(file)).toBe(false);
  });

  it("borrows retained source writers without closing their controller lifetime", async () => {
    const store = await session();
    await SessionStore.withSource(store.getSessionFile(), async (source) => {
      expect(source).toBe(store);
    });
    expect(await lockfile.check(store.getSessionFile())).toBe(true);
    await store.appendMessage({ role: "user", content: "still owned", timestamp: 2 });
    expect(store.getEntries()).toHaveLength(2);
  });

  it("shares temporary readers until the last lease ends", async () => {
    const store = await session();
    const file = store.getSessionFile();
    await store.close();
    const firstReady = gate();
    const secondReady = gate();
    const firstDone = gate();
    const secondDone = gate();
    let shared: SessionStore | undefined;
    const first = SessionStore.withSource(file, async (source) => {
      shared = source;
      firstReady.resolve();
      await firstDone.promise;
    });
    await firstReady.promise;
    const second = SessionStore.withSource(file, async (source) => {
      expect(source).toBe(shared);
      secondReady.resolve();
      await secondDone.promise;
    });
    await secondReady.promise;
    firstDone.resolve();
    await first;
    expect(await lockfile.check(file)).toBe(true);
    secondDone.resolve();
    await second;
    expect(await lockfile.check(file)).toBe(false);
  });

  it("lets concurrent open retain a writer initially acquired by a source copy", async () => {
    const store = await session();
    const file = store.getSessionFile();
    await store.close();
    const ready = gate();
    const done = gate();
    let shared: SessionStore | undefined;
    const copy = SessionStore.withSource(file, async (source) => {
      shared = source;
      ready.resolve();
      await done.promise;
    });
    await ready.promise;
    const retained = await SessionStore.open(file);
    stores.push(retained);
    expect(retained).toBe(shared);
    done.resolve();
    await copy;
    expect(await lockfile.check(file)).toBe(true);
    await retained.close();
    expect(await lockfile.check(file)).toBe(false);
  });

  it("waits scoped readers before closing and serializes an open racing that close", async () => {
    const store = await session();
    const file = store.getSessionFile();
    const ready = gate();
    const done = gate();
    const copy = SessionStore.withSource(file, async (source) => {
      expect(source).toBe(store);
      ready.resolve();
      await done.promise;
      expect(source.getEntries()).toHaveLength(1);
    });
    await ready.promise;
    let closed = false;
    const close = store.close().then(() => {
      closed = true;
    });
    const reopening = SessionStore.open(file);
    expect(closed).toBe(false);
    expect(await lockfile.check(file)).toBe(true);
    done.resolve();
    await Promise.all([copy, close]);
    const retained = await reopening;
    stores.push(retained);
    expect(retained).not.toBe(store);
    expect(await lockfile.check(file)).toBe(true);
    await store.close();
    expect(await lockfile.check(file)).toBe(true);
  });
  it("keeps regular tool preferences independent of native declaration tools", async () => {
    const store = await session(true);
    await store.conversation.commit(async (tx) => {
      (await tx.doc(AgentDoc, store.conversation.id)).tools = ["codemode"];
    }, context);
    expect((await store.configuration()).activeToolNames).toBeUndefined();
    expect(store.getEntries()).toEqual([]);
    await store.appendCustomEntry(SESSION_TOOLS_CUSTOM_TYPE, { activeToolNames: ["read"] });
    expect((await store.configuration()).activeToolNames).toEqual(["read"]);
    expect(await store.harness.snapshot(AgentDoc, store.conversation.id, context)).toMatchObject({
      tools: ["codemode"],
    });
    await store.conversation.configure({ tools: [] }, context);
    expect((await store.configuration()).activeToolNames).toEqual(["read"]);
    await store.refresh();
    expect(store.getEntries()).toHaveLength(1);
    await store.close();
    const reopened = await SessionStore.open(store.getSessionFile());
    stores.push(reopened);
    expect((await reopened.configuration()).activeToolNames).toEqual(["read"]);
  });

  it("projects positional system messages with structured prompt sections", async () => {
    const store = await session(true);
    const message = {
      role: "system" as const,
      content: "",
      sections: { preamble: "instructions", old: null },
      timestamp: 2,
    };
    await store.conversation.commit(
      (tx) => tx.appendEntry(store.conversation.id, { kind: "pi.system", model: [message] }),
      context,
    );
    await store.refresh();
    expect(store.getEntries()[0]).toMatchObject({ type: "message", message });
    await store.close();
    expect((await SessionStore.read(store.getSessionFile())).entries[0]).toMatchObject({
      type: "message",
      message,
    });
  });

  it("uses the latest raw model timestamp despite stale SQLite main-file mtime", async () => {
    const store = await session(true);
    const latest = Date.now() + 60_000;
    await store.conversation.commit(
      (tx) =>
        tx.appendEntry(store.conversation.id, {
          kind: "pi.user",
          model: [
            { role: "user", content: "first", timestamp: 1 },
            { role: "user", content: "latest", timestamp: latest },
          ],
        }),
      context,
    );
    await fs.utimes(store.getSessionFile(), new Date(0), new Date(0));
    expect((await SessionStore.read(store.getSessionFile())).metadata.modifiedAt).toBe(latest);
    await store.close();
    expect((await SessionStore.read(store.getSessionFile())).metadata.modifiedAt).toBe(latest);
  });

  it("aggregates independent nested artifact receipts without duplicating retry artifacts", async () => {
    const store = await session(true);
    const first = { path: "first.txt" };
    const second = { path: "second.txt" };
    await store.conversation.commit(
      (tx) =>
        tx.appendEntry(store.conversation.id, {
          kind: "pi.tool-result",
          data: { sourceToolTaskId: 99 },
          model: [
            {
              role: "toolResult",
              toolCallId: "outer",
              toolName: "codemode",
              content: [],
              details: { sentFiles: [first] },
              isError: false,
              timestamp: 1,
            },
          ],
        }),
      context,
    );
    await store.appendCustomEntry("batty.tool-artifacts", {
      toolTaskId: 99,
      nestedToolCallId: "one",
      details: { sentFiles: [first], sites: [{ id: "site-one" }] },
    });
    await store.appendCustomEntry("batty.tool-artifacts", {
      toolTaskId: 99,
      nestedToolCallId: "two",
      details: { sentFiles: [second], battyFileChanges: [{ path: "written.txt" }] },
    });
    await store.appendCustomEntry("batty.tool-artifacts", {
      toolTaskId: 99,
      nestedToolCallId: "two",
      details: { sentFiles: [second], battyFileChanges: [{ path: "written.txt" }] },
    });
    expect(store.getEntries()[0]).toMatchObject({
      message: {
        details: {
          sentFiles: [first, second],
          sites: [{ id: "site-one" }],
          battyFileChanges: [{ path: "written.txt" }],
        },
      },
    });
    expect((await store.conversation.context(context)).contributions[0]![0]).toMatchObject({
      details: { sentFiles: [first] },
    });
    await store.close();
    expect((await SessionStore.read(store.getSessionFile())).entries).toEqual(store.getEntries());
  });

  it("persists empty sessions atomically and opens them paused with populated caches", async () => {
    const store = await session(true);
    const file = store.getSessionFile();
    expect(file.endsWith(".sqlite")).toBe(true);
    expect((await fs.readFile(file)).subarray(0, 16).toString()).toBe("SQLite format 3\0");
    expect((await store.harness.inspect(context)).scheduling).toBe("paused");
    expect(store.getEntries()).toEqual([]);
    await store.close();
    const snapshot = await SessionStore.read(file, { readOnly: true });
    expect(snapshot.metadata.id).toBe(store.getSessionId());
    expect(snapshot.entries).toEqual([]);
    const reopened = await SessionStore.existing(
      store.getCwd(),
      store.getSessionDir(),
      store.getSessionId(),
    );
    stores.push(reopened!);
    expect(reopened!.getEntries()).toEqual([]);
    expect((await reopened!.harness.inspect(context)).scheduling).toBe("paused");
  });

  it.each(["high", "off"] as const)(
    "stores explicit %s thinking/model/tools in AgentDoc",
    async (thinkingLevel) => {
      const store = await session();
      expect(await store.configuration()).toEqual({
        model: undefined,
        thinkingLevel: undefined,
        activeToolNames: undefined,
      });
      const selected = {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel,
        activeToolNames: ["read"],
      };
      await store.configure(selected);
      expect(await store.harness.snapshot(AgentDoc, store.conversation.id, context)).toMatchObject({
        model: selected.model,
        thinkingLevel,
        tools: ["read"],
      });
      await store.close();
      const reopened = await SessionStore.open(store.getSessionFile());
      stores.push(reopened);
      expect(await reopened.configuration()).toEqual(selected);
      expect(reopened.getEntries().at(-1)).toMatchObject({
        type: "custom",
        customType: "batty-session-tools",
        data: { activeToolNames: ["read"] },
      });
    },
  );

  it("shares concurrent opens and retains its writer lock until coordinated close", async () => {
    const store = await session();
    const file = store.getSessionFile();
    expect(await lockfile.check(file)).toBe(true);
    await store.close();
    const [first, second] = await Promise.all([SessionStore.open(file), SessionStore.open(file)]);
    stores.push(first);
    expect(first).toBe(second);
    expect(first.getEntries()).toEqual(store.getEntries());
    await first.release();
    expect(await lockfile.check(file)).toBe(false);
  });

  it("reads committed history without creating or running generation", async () => {
    const store = await session();
    await store.close();
    const snapshot = await SessionStore.read(store.getSessionFile(), { readOnly: true });
    expect(snapshot.entries).toEqual(store.getEntries());
    const reopened = await SessionStore.open(store.getSessionFile());
    stores.push(reopened);
    expect((await reopened.harness.inspect(context)).tasks).toEqual([]);
    expect((await reopened.harness.inspect(context)).scheduling).toBe("paused");
  });

  it("rejects old JSONL instead of importing or modifying it", async () => {
    const store = await session();
    const file = path.join(store.getSessionDir(), "old.jsonl");
    const old = JSON.stringify({ type: "session", version: 3, id: "old" }) + "\n";
    await fs.writeFile(file, old);
    await expect(SessionStore.open(file)).rejects.toThrow("Expected durable SQLite session");
    await expect(SessionStore.read(file)).rejects.toThrow("Expected durable SQLite session");
    expect(await fs.readFile(file, "utf8")).toBe(old);
    expect(await fs.readdir(store.getSessionDir())).not.toContain("old.jsonl.durable");
  });

  it("refreshes committed entries and decorates artifacts without changing model context", async () => {
    const store = await session();
    await store.conversation.commit(async (tx) => {
      await tx.appendEntry(store.conversation.id, {
        kind: "batty.custom-message",
        data: { customType: "notice", content: "display only", display: true, timestamp: 10 },
      });
      await tx.appendEntry(store.conversation.id, {
        kind: "pi.tool-result",
        model: [
          {
            role: "toolResult",
            toolCallId: "call",
            toolName: "write",
            content: [{ type: "text", text: "done" }],
            isError: false,
            timestamp: 11,
          },
        ],
      });
    }, context);
    expect(store.getEntries()).toHaveLength(3);
    await store.refresh();
    expect(store.getEntries()).toHaveLength(3);
    expect(store.getEntries()[1]).toMatchObject({ type: "custom_message", customType: "notice" });
    expect((await store.conversation.context(context)).messages).not.toContainEqual(
      expect.objectContaining({ content: "display only" }),
    );
    await store.close();
    expect((await SessionStore.read(store.getSessionFile())).entries).toEqual(store.getEntries());
  });

  it("forks a cutoff to an independent database preserving head markers, edits, and agent choices", async () => {
    const store = await session();
    await store.configure({ model: { provider: "faux", modelId: "one" }, thinkingLevel: "high" });
    const records = await store.conversation.commit(async (tx) => {
      const kept = await tx.appendEntry(store.conversation.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "kept", timestamp: 2 }],
      });
      const edit = await tx.appendEntry(store.conversation.id, {
        kind: "batty.edit",
        edits: [
          {
            target: kept.id,
            action: "replace",
            messages: [{ role: "user", content: "edited", timestamp: 2 }],
          },
        ],
      });
      const summary = await tx.appendEntry(store.conversation.id, {
        kind: "pi.compaction",
        head: kept.id,
        model: [{ role: "user", content: "summary", timestamp: 3 }],
      });
      return { kept, edit, summary };
    }, context);
    await store.refresh();
    const expectedContext = (await store.conversation.context(context)).messages;
    await store.appendMessage({ role: "user", content: "future", timestamp: 4 });
    await store.configure({ model: { provider: "faux", modelId: "two" } });
    const id = randomUUID();
    const fork = await store.fork(
      path.join(store.getCwd(), "fork"),
      String(records.summary.id),
      id,
    );
    stores.push(fork);
    expect(fork.getSessionId()).toBe(id);
    expect(fork.getHeader().parentSession).toBe(store.getSessionFile());
    expect((await fork.conversation.context(context)).messages).toEqual(expectedContext);
    expect((await fork.configuration()).model?.modelId).toBe("one");
    expect(fork.buildSessionProjection().messages).toEqual(expectedContext);
    await fork.close();
    const reopened = await SessionStore.open(fork.getSessionFile());
    stores.push(reopened);
    expect((await reopened.conversation.context(context)).messages).toEqual(expectedContext);
  });

  it("preserves custom-input and client metadata across read and independent forks", async () => {
    const store = await session(true);
    const metadata = { customType: "notification", display: true, details: { source: "cron" } };
    const requestId = `custom-input:${Buffer.from(JSON.stringify(metadata)).toString("base64url")}:id`;
    await store.conversation.commit(async (tx) => {
      const custom = await tx.appendEntry(store.conversation.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "wake up", timestamp: 1 }],
      });
      await tx.createSubmission({
        conversationId: store.conversation.id,
        requestId,
        type: "input",
        status: "unanswered",
        entry: custom.id,
        reason: "test",
      });
      const client = await tx.appendEntry(store.conversation.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "hello", timestamp: 2 }],
      });
      await tx.createSubmission({
        conversationId: store.conversation.id,
        requestId: "client:client-123",
        type: "input",
        status: "unanswered",
        entry: client.id,
        reason: "test",
      });
    }, context);
    await store.refresh();
    expect(store.getEntries()[0]).toMatchObject({
      type: "custom_message",
      customType: "notification",
      content: "wake up",
      details: { source: "cron" },
    });
    expect(store.getEntries()[1]).toMatchObject({
      type: "message",
      message: { clientMessageId: "client-123" },
    });
    const fork = await store.fork(path.join(store.getCwd(), "custom-fork"));
    stores.push(fork);
    expect(fork.getEntries()[0]).toMatchObject({
      type: "custom_message",
      customType: "notification",
      content: "wake up",
    });
    expect(fork.getEntries()[1]).toMatchObject({
      type: "message",
      message: { clientMessageId: "client-123" },
    });
    expect(fork.buildSessionProjection().messages[0]).toMatchObject({
      role: "custom",
      customType: "notification",
    });
    expect(fork.buildSessionProjection().messages[1]).toMatchObject({
      role: "user",
      clientMessageId: "client-123",
    });
    await fork.close();
    expect((await SessionStore.read(fork.getSessionFile())).entries).toEqual(fork.getEntries());
  });

  it("applies late committed artifact receipts only to UI copies and preserves them on fork", async () => {
    const store = await session(true);
    await store.conversation.commit(
      (tx) =>
        tx.appendEntry(store.conversation.id, {
          kind: "pi.tool-result",
          data: { sourceToolTaskId: 99 },
          model: [
            {
              role: "toolResult",
              toolCallId: "call",
              toolName: "write",
              content: [{ type: "text", text: "done" }],
              details: { original: true },
              isError: false,
              timestamp: 1,
            },
          ],
        }),
      context,
    );
    await store.appendCustomEntry("batty.tool-artifacts", {
      toolTaskId: 99,
      details: { artifactPath: "/output/file" },
    });
    expect(store.getEntries()[0]).toMatchObject({
      message: { details: { original: true, artifactPath: "/output/file" } },
    });
    expect(store.buildSessionProjection().messages[0]).toMatchObject({
      details: { artifactPath: "/output/file" },
    });
    expect((await store.conversation.context(context)).contributions[0]![0]).toMatchObject({
      details: { original: true },
    });
    expect((await store.conversation.context(context)).contributions[0]![0]).not.toMatchObject({
      details: { artifactPath: "/output/file" },
    });
    const fork = await store.fork(path.join(store.getCwd(), "artifact-fork"));
    stores.push(fork);
    expect(fork.getEntries()[0]).toMatchObject({
      message: { details: { artifactPath: "/output/file" } },
    });
    // Task IDs are local to a database: a new task must not inherit an ancestor receipt.
    await fork.conversation.commit(
      (tx) =>
        tx.appendEntry(fork.conversation.id, {
          kind: "pi.tool-result",
          data: { sourceToolTaskId: 99 },
          model: [
            {
              role: "toolResult",
              toolCallId: "new-call",
              toolName: "write",
              content: [{ type: "text", text: "new" }],
              details: { fresh: true },
              isError: false,
              timestamp: 2,
            },
          ],
        }),
      context,
    );
    await fork.refresh();
    expect(fork.getEntries().at(-1)).toMatchObject({ message: { details: { fresh: true } } });
    expect(fork.getEntries().at(-1)).not.toMatchObject({
      message: { details: { artifactPath: "/output/file" } },
    });
  });

  it("preserves custom AgentMessages as native custom durable records", async () => {
    const store = await session(true);
    await store.appendMessage({
      role: "custom",
      customType: "notice",
      content: "a notice",
      display: true,
      details: { source: "host" },
      timestamp: 123,
    });
    expect(store.getEntries()[0]).toMatchObject({ type: "custom_message", customType: "notice" });
    expect(store.buildSessionProjection().messages[0]).toMatchObject({
      role: "custom",
      content: "a notice",
    });
    expect((await store.conversation.context(context)).messages[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "a notice" }],
    });
  });

  it("owns durable display names and labels without adding model messages", async () => {
    const store = await session();
    const target = store.getLeafId()!;
    await store.setSessionName("A session");
    await store.setLabel(target, "bookmark");
    expect(store.getSessionName()).toBe("A session");
    expect(store.getLabel(target)).toBe("bookmark");
    expect(store.getTree()[0]?.label).toBe("bookmark");
    expect(store.buildSessionProjection().messages).toHaveLength(1);
    await store.close();
    const reopened = await SessionStore.open(store.getSessionFile());
    stores.push(reopened);
    expect(reopened.getSessionName()).toBe("A session");
    expect(reopened.getLabel(target)).toBe("bookmark");
  });

  it("forks an empty history and does not affect the original cache", async () => {
    const store = await session();
    const entries = store.getEntries();
    const fork = await store.fork(path.join(store.getCwd(), "empty-fork"), null);
    stores.push(fork);
    expect(fork.getEntries()).toEqual([]);
    expect(fork.getLeafId()).toBeNull();
    expect(store.getEntries()).toEqual(entries);
  });

  it("publishes snapshots for custom writes, configuration and durable refresh", async () => {
    const store = await session();
    const snapshots: unknown[] = [];
    const unsubscribe = SessionStore.subscribe((_file, snapshot) => snapshots.push(snapshot));
    try {
      await store.appendCustomEntry("test", { value: 1 });
      await store.configure({ thinkingLevel: "high" });
      expect(snapshots).toHaveLength(2);
      expect(snapshots[1]).toMatchObject({ entries: store.getEntries() });
    } finally {
      unsubscribe();
    }
  });
});
