import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, type TaskId } from "@earendil-works/pi-durable";
import { SessionStore } from "./session-store";
import { openDurableSession } from "./durable-session-store";

const context = BACKGROUND_CONTEXT;
const options = () => ({ models: createModels(), registry: createRegistry() });
const roots: string[] = [];
const stores: SessionStore[] = [];
const opened: Awaited<ReturnType<typeof openDurableSession>>[] = [];
afterEach(async () => {
  for (const session of opened.splice(0)) await session.close();
  for (const store of stores.splice(0)) store.release();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-durable-store-"));
  roots.push(root);
  const store = await SessionStore.create(root, path.join(root, "sessions"));
  stores.push(store);
  return store;
}
async function open(store: SessionStore) {
  const durable = await openDurableSession(store, options());
  opened.push(durable);
  return durable;
}
async function entries(session: Awaited<ReturnType<typeof open>>) {
  return (await session.conversation.entries({}, 500, undefined, context)).items;
}
function messages(store: SessionStore) {
  return store.getEntries().filter((entry) => entry.type === "message");
}

describe("durable session projection", () => {
  it("bootstraps only the selected branch once, including model-visible custom messages", async () => {
    const store = await setup();
    const first = await store.appendMessage({ role: "user", content: "first", timestamp: 1 });
    await store.appendMessage({ role: "user", content: "abandoned", timestamp: 2 });
    store.native.branch(first);
    store.native.appendCustomMessageEntry("host-context", "host instructions", true);
    await store.appendCustomEntry("batty:state", { value: 1 });
    const before = store.getEntries();
    const session = await open(store);
    expect(store.getEntries()).toEqual(before);
    expect(
      (await session.conversation.context(context)).messages.map((message) => message.content),
    ).toEqual(["first", [{ type: "text", text: "host instructions" }]]);
    const imported = await entries(session);
    await session.close();
    const reopened = await open(store);
    expect(await entries(reopened)).toEqual(imported);
    expect(store.getEntries()).toEqual(before);
  });

  it("recovers unprojected commits and embeds identity in the same message record", async () => {
    const store = await setup();
    await store.appendMessage({ role: "user", content: "old", timestamp: 1 });
    const session = await open(store);
    const record = await session.conversation.commit(
      (tx) =>
        tx.appendEntry(session.conversation.id, {
          kind: "pi.user",
          model: [{ role: "user", content: "committed", timestamp: 2 }],
          data: { clientMessageId: "client-id" },
        }),
      context,
    );
    await session.close();
    store.release();
    const reopenedStore = await SessionStore.open(store.getSessionFile());
    stores.push(reopenedStore);
    const recovered = await open(reopenedStore);
    expect(messages(reopenedStore)).toHaveLength(2);
    expect(messages(reopenedStore)[1]!.message).toMatchObject({
      content: "committed",
      battyDurableEntryId: String(record.id),
      clientMessageId: "client-id",
    });
    await Promise.all([recovered.projectEntries([record]), recovered.projectEntries([record])]);
    await recovered.syncHostEntries();
    expect(messages(reopenedStore)).toHaveLength(2);
    expect(await entries(recovered)).toHaveLength(2);
    await recovered.close();
    await open(reopenedStore);
    expect(messages(reopenedStore)).toHaveLength(2);
  });

  it("imports host additions idempotently without echoing them into the old file", async () => {
    const store = await setup();
    const session = await open(store);
    await store.appendMessage({ role: "user", content: "host", timestamp: 1 });
    store.native.appendCustomMessageEntry("injection", "injected", false);
    await store.appendCustomEntry("host-state", { n: 3 });
    const before = store.getEntries();
    await Promise.all([session.syncHostEntries(), session.syncHostEntries()]);
    const records = await entries(session);
    expect(records).toHaveLength(3);
    await session.projectEntries(records);
    expect(store.getEntries()).toEqual(before);
    expect(
      (await session.conversation.context(context)).messages.map((message) => message.content),
    ).toEqual(["host", [{ type: "text", text: "injected" }]]);
  });

  it("projects compaction with an atomic details mapping and preserves durable context", async () => {
    const store = await setup();
    const session = await open(store);
    const user = await session.conversation.commit(
      (tx) =>
        tx.appendEntry(session.conversation.id, {
          kind: "pi.user",
          model: [{ role: "user", content: "kept", timestamp: 1 }],
        }),
      context,
    );
    const compact = await session.conversation.commit(
      (tx) =>
        tx.appendEntry(session.conversation.id, {
          kind: "pi.compaction",
          head: user.id,
          model: [{ role: "user", content: "summary", timestamp: 2 }],
          data: { reason: "manual" },
        }),
      context,
    );
    await session.projectEntries([compact, user]);
    const projection = store.getEntries().find((entry) => entry.type === "compaction");
    expect(projection).toMatchObject({
      summary: "summary",
      details: { durableEntryId: String(compact.id) },
    });
    await session.close();
    const reopened = await open(store);
    expect(store.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
    expect(
      (await reopened.conversation.context(context)).messages.map((message) => message.content),
    ).toEqual(["summary", "kept"]);
  });

  it("recovers client message identity from the durable submission request", async () => {
    const store = await setup();
    const session = await open(store);
    const user = await session.conversation.commit(async (tx) => {
      const record = await tx.appendEntry(session.conversation.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "sent", timestamp: 1 }],
      });
      await tx.createSubmission({
        conversationId: session.conversation.id,
        requestId: "client:browser-message",
        type: "input",
        status: "placed",
        entry: record.id,
      });
      return record;
    }, context);
    await Promise.all([session.projectEntries([user]), session.projectEntries([user])]);
    expect(messages(store)).toHaveLength(1);
    expect(messages(store)[0]!.message).toMatchObject({ clientMessageId: "browser-message" });
  });

  it("imports legacy compaction boundaries without resurrecting compacted history", async () => {
    const store = await setup();
    await store.appendMessage({ role: "user", content: "discarded", timestamp: 1 });
    const kept = await store.appendMessage({ role: "user", content: "kept", timestamp: 2 });
    store.native.appendCompaction("legacy summary", kept, 100);
    const session = await open(store);
    const model = (await session.conversation.context(context)).messages;
    expect(JSON.stringify(model)).not.toContain("discarded");
    expect(JSON.stringify(model)).toContain("legacy summary");
    expect(JSON.stringify(model)).toContain("kept");
    expect(store.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
  });

  it.each([false, true])(
    "projects custom writes with model visibility %s and atomic identity",
    async (visible) => {
      const store = await setup();
      const session = await open(store);
      const record = await session.conversation.commit(
        (tx) =>
          tx.appendEntry(session.conversation.id, {
            kind: "batty.custom-message",
            data: {
              customType: "host:message",
              content: "custom",
              display: true,
              details: { source: "host" },
              timestamp: 1,
            },
            ...(visible
              ? { model: [{ role: "user" as const, content: "custom", timestamp: 1 }] }
              : {}),
          }),
        context,
      );
      await Promise.all([session.projectEntries([record]), session.projectEntries([record])]);
      const custom = store.getEntries().filter((entry) => entry.type === "custom_message");
      expect(custom).toHaveLength(1);
      expect(custom[0]).toMatchObject({
        customType: "host:message",
        content: "custom",
        display: true,
        details: { source: "host", durableEntryId: String(record.id) },
      });
      await session.syncHostEntries();
      expect(await entries(session)).toHaveLength(1);
      await session.close();
      const reopened = await open(store);
      expect(store.getEntries().filter((entry) => entry.type === "custom_message")).toHaveLength(1);
      expect((await reopened.conversation.context(context)).messages).toHaveLength(visible ? 1 : 0);
      const fork = await store.fork(path.join(store.native.getCwd(), "custom-fork"));
      stores.push(fork);
      const forkSession = await open(fork);
      expect((await forkSession.conversation.context(context)).messages).toHaveLength(
        visible ? 1 : 0,
      );
    },
  );

  it("bootstraps projected ancestor messages into a fork's independent sidecar", async () => {
    const store = await setup();
    const session = await open(store);
    const record = await session.conversation.commit(
      (tx) =>
        tx.appendEntry(session.conversation.id, {
          kind: "pi.user",
          model: [{ role: "user", content: "ancestor", timestamp: 1 }],
        }),
      context,
    );
    await session.projectEntries([record]);
    const fork = await store.fork(path.join(store.native.getCwd(), "fork"));
    stores.push(fork);
    const forkSession = await open(fork);
    expect(
      (await forkSession.conversation.context(context)).messages.map((message) => message.content),
    ).toEqual(["ancestor"]);
    await forkSession.syncHostEntries();
    expect(await entries(forkSession)).toHaveLength(1);
    const added = await forkSession.conversation.commit(
      (tx) =>
        tx.appendEntry(forkSession.conversation.id, {
          kind: "pi.user",
          model: [{ role: "user", content: "fork-only", timestamp: 2 }],
        }),
      context,
    );
    await forkSession.projectEntries([added]);
    expect(messages(fork)).toHaveLength(2);
    expect(messages(store)).toHaveLength(1);
    await forkSession.close();
    const reopened = await open(fork);
    expect(
      (await reopened.conversation.context(context)).messages.map((message) => message.content),
    ).toEqual(["ancestor", "fork-only"]);
    expect(messages(fork)).toHaveLength(2);
  });

  it("repairs missing imported presentation entries from committed legacy data", async () => {
    const store = await setup();
    await store.appendMessage({ role: "user", content: "old input", timestamp: 1 });
    store.native.appendCustomMessageEntry("old:custom", "old custom", true, { source: "legacy" });
    await store.appendCustomEntry("old:state", { value: 3 });
    store.native.appendModelChange("faux", "model");
    const kept = await store.appendMessage({ role: "user", content: "kept", timestamp: 2 });
    store.native.appendCompaction("old summary", kept, 100);
    const session = await open(store);
    const authoritative = (await session.conversation.context(context)).messages;
    await session.close();
    const file = store.getSessionFile();
    store.release();
    const header = (await fs.readFile(file, "utf8")).split("\n")[0]!;
    await fs.writeFile(file, `${header}\n`);
    const empty = await SessionStore.open(file);
    stores.push(empty);
    const recovered = await open(empty);
    expect(messages(empty)).toHaveLength(2);
    expect(empty.getEntries().find((entry) => entry.type === "custom_message")).toMatchObject({
      content: "old custom",
      details: { source: "legacy" },
    });
    expect(
      empty
        .getEntries()
        .find((entry) => entry.type === "custom" && entry.customType === "old:state"),
    ).toMatchObject({ data: { value: 3 } });
    expect(empty.getEntries().find((entry) => entry.type === "model_change")).toMatchObject({
      provider: "faux",
      modelId: "model",
    });
    expect(empty.getEntries().find((entry) => entry.type === "compaction")).toMatchObject({
      summary: "old summary",
    });
    expect((await recovered.conversation.context(context)).messages).toEqual(authoritative);
    const importedCount = (await entries(recovered)).length;
    await recovered.syncHostEntries();
    expect(await entries(recovered)).toHaveLength(importedCount);
    const repaired = empty.getEntries();
    await recovered.close();
    await open(empty);
    expect(empty.getEntries()).toEqual(repaired);
  });

  it("projects a triggered custom input as one custom notice without a duplicate user entry", async () => {
    const store = await setup();
    const session = await open(store);
    const encoded = Buffer.from(
      JSON.stringify({
        deliveryId: "delivery-1",
        customType: "host:result",
        display: true,
        details: { title: "Result" },
      }),
    ).toString("base64url");
    const input = await session.conversation.commit(async (tx) => {
      const record = await tx.appendEntry(session.conversation.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "result text", timestamp: 1 }],
      });
      await tx.createSubmission({
        conversationId: session.conversation.id,
        type: "input",
        status: "placed",
        entry: record.id,
        requestId: `custom-input:${encoded}:0`,
      });
      return record;
    }, context);
    // Reopening must recover both the input and its custom presentation metadata.
    await session.close();
    const reopened = await open(store);
    await reopened.projectEntries([input]);
    expect(messages(store)).toHaveLength(0);
    const custom = store.getEntries().filter((entry) => entry.type === "custom_message");
    expect(custom).toHaveLength(1);
    expect(custom[0]).toMatchObject({
      customType: "host:result",
      content: "result text",
      display: true,
      details: { title: "Result", durableEntryId: String(input.id), durableModel: input.model },
    });
    await reopened.syncHostEntries();
    expect(await entries(reopened)).toHaveLength(1);
    expect(
      (await reopened.conversation.context(context)).messages.map((message) => message.content),
    ).toEqual(["result text"]);
    const fork = await store.fork(path.join(store.native.getCwd(), "triggered-fork"));
    stores.push(fork);
    const forkSession = await open(fork);
    expect(
      (await forkSession.conversation.context(context)).messages.map((message) => message.content),
    ).toEqual(["result text"]);
    await reopened.close();
    await open(store);
    expect(store.getEntries().filter((entry) => entry.type === "custom_message")).toHaveLength(1);
  });

  it("projects committed tool artifacts onto cancellation results without mixing later reused call IDs", async () => {
    const store = await setup();
    const session = await open(store);
    async function artifact(path: string, toolTaskId: number) {
      return session.conversation.commit(
        (tx) =>
          tx.appendEntry(session.conversation.id, {
            kind: "batty.tool-artifacts",
            data: {
              toolCallId: "call",
              toolTaskId,
              details: {
                battyFileChanges: [{ path, before: null, after: "written" }],
              },
            },
          }),
        context,
      );
    }
    const first = await artifact("first.txt", 101);
    const result = await session.conversation.commit(
      (tx) =>
        tx.appendEntry(session.conversation.id, {
          kind: "pi.tool-result",
          model: [
            {
              role: "toolResult",
              toolCallId: "call",
              toolName: "write",
              content: [{ type: "text", text: "aborted" }],
              isError: true,
              timestamp: 1,
              details: { existing: true },
            },
          ],
        }),
      context,
    );
    // Host commits lack task attribution; supply the projection contract's task
    // identity explicitly without starting a scheduler/model run in this unit test.
    const attributed = { ...result, byTaskId: 101 as TaskId };
    await session.projectEntries([first, attributed]);
    const later = await artifact("later.txt", 202);
    await session.close();
    const recovered = await open(store);
    const projected = messages(store).find((entry) => entry.message.role === "toolResult");
    expect(projected).toMatchObject({
      message: {
        isError: true,
        details: {
          existing: true,
          battyFileChanges: [{ path: "first.txt", before: null, after: "written" }],
        },
      },
    });
    expect(
      store
        .getEntries()
        .filter((entry) => entry.type === "custom" && entry.customType === "batty.tool-artifacts"),
    ).toHaveLength(2);
    await recovered.projectEntries([first, attributed, later]);
    await recovered.syncHostEntries();
    expect(await entries(recovered)).toHaveLength(3);
    expect(messages(store)).toHaveLength(1);
  });

  it("overlays late artifact receipts on projected copies and survives reopening", async () => {
    const store = await setup();
    const session = await open(store);
    const result = await session.conversation.commit(
      (tx) =>
        tx.appendEntry(session.conversation.id, {
          kind: "pi.tool-result",
          model: [
            {
              role: "toolResult",
              toolCallId: "reused",
              toolName: "write",
              content: [{ type: "text", text: "cancelled" }],
              isError: true,
              timestamp: 1,
              details: { existing: true },
            },
          ],
        }),
      context,
    );
    await session.projectEntries([{ ...result, byTaskId: 123 as TaskId }]);
    const raw = store.native.getEntries().find((entry) => entry.type === "message")!;
    expect(raw).toMatchObject({
      message: { battyDurableTaskId: 123, details: { existing: true } },
    });
    const artifact = await session.conversation.commit(
      (tx) =>
        tx.appendEntry(session.conversation.id, {
          kind: "batty.tool-artifacts",
          data: {
            toolCallId: "reused",
            toolTaskId: 123,
            details: { battyFileChanges: [{ path: "late.txt", before: null, after: "written" }] },
          },
        }),
      context,
    );
    await session.projectEntries([artifact]);
    const expected = {
      message: {
        battyDurableTaskId: 123,
        isError: true,
        details: {
          existing: true,
          battyFileChanges: [{ path: "late.txt", before: null, after: "written" }],
        },
      },
    };
    expect(messages(store)[0]).toMatchObject(expected);
    expect(store.getBranch().find((entry) => entry.type === "message")).toMatchObject(expected);
    expect(raw).toMatchObject({ message: { details: { existing: true } } });
    expect(
      raw.type === "message" && raw.message.role === "toolResult" && raw.message.details,
    ).toEqual({ existing: true });
    await session.close();
    const file = store.getSessionFile();
    store.release();
    const reopenedStore = await SessionStore.open(file);
    stores.push(reopenedStore);
    const reopened = await open(reopenedStore);
    expect(messages(reopenedStore)[0]).toMatchObject(expected);
    expect(messages(reopenedStore)).toHaveLength(1);
    await reopened.syncHostEntries();
    expect(await entries(reopened)).toHaveLength(2);
    reopenedStore.release();
    expect(
      (await SessionStore.read(file)).entries.find((entry) => entry.type === "message"),
    ).toMatchObject(expected);
  });

  it("projects positional system entries after input with their prompt metadata", async () => {
    const store = await setup();
    const session = await open(store);
    const input = await session.conversation.commit(
      (tx) =>
        tx.appendEntry(session.conversation.id, {
          kind: "pi.user",
          model: [{ role: "user", content: "input", timestamp: 1 }],
        }),
      context,
    );
    const system = await session.conversation.commit(
      (tx) =>
        tx.appendEntry(session.conversation.id, {
          kind: "pi.system",
          model: [
            {
              role: "system",
              content: "",
              sections: { instructions: "Follow host instructions" },
              timestamp: 2,
            },
          ],
        }),
      context,
    );
    await session.projectEntries([system, input]);
    expect(messages(store).map((entry) => entry.message.role)).toEqual(["user", "system"]);
    expect(messages(store)[1]!.message).toMatchObject({
      role: "system",
      content: "",
      sections: { instructions: "Follow host instructions" },
      battyDurableEntryId: String(system.id),
    });
    await session.syncHostEntries();
    expect(await entries(session)).toHaveLength(2);
    await session.close();
    const reopened = await open(store);
    expect(messages(store)).toHaveLength(2);
    expect(
      (await reopened.conversation.context(context)).messages.map((message) => message.role),
    ).toEqual(["user", "system"]);
  });

  it("locks the sidecar against a second writer and releases it on close", async () => {
    const store = await setup();
    const session = await open(store);
    await expect(openDurableSession(store, options())).rejects.toThrow();
    await session.close();
    await expect(open(store)).resolves.toBeDefined();
  });
});
