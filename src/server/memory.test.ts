import { expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context, withCancel } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { MemoryNodesDoc, MemoryMaintenanceDoc, MemoryIndexDoc, utf8Bytes } from "./memory";
import { fixture, cleanup } from "./memory-test-fixture";

test("projection, immutable nodes and exact zoom survive reopen without resummarization", async () => {
  const fixtureState = await fixture();
  let state = await fixtureState.open();
  const exact = "æ".repeat(100);
  await state.main.commit(async (tx) => {
    for (let i = 0; i < 8; i++)
      await tx.appendEntry(state.main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: `${i}:${exact}`, timestamp: i + 1 }],
      });
  }, context);
  const first = await state.memory.prepare();
  expect(first).not.toContain("not summarized");
  expect(first).toContain("summary");
  expect(await state.memory.zoom(0, 1)).toBe(`0+0|[1970-01-01T00:00:00.001Z] user: 0:${exact}`);
  expect(await state.memory.date(0)).toBe("1970-01-01T00:00:00.001Z");
  const calls = fixtureState.compressions();
  await state.harness.close(context);
  state = await fixtureState.open();
  cleanup.push(() => state.harness.close(context));
  expect(await state.memory.prepare()).toBe(first);
  expect(fixtureState.compressions()).toBe(calls);
  expect(await state.memory.zoom(0, 2)).toContain(
    "1+1|[1970-01-01T00:00:00.002Z .. 1970-01-01T00:00:00.002Z]",
  );
  const expanded = await state.memory.zoom(0, 8);
  expect(expanded).toContain("0+4|[1970-01-01T00:00:00.001Z .. 1970-01-01T00:00:00.004Z]");
  expect(expanded).toContain("4+4|[1970-01-01T00:00:00.005Z .. 1970-01-01T00:00:00.008Z]");
  await expect(state.memory.zoom(1, 2)).rejects.toThrow("No line");
});

test("SQLite reopening preserves an unfinished batch and completes it on new input", async () => {
  const f = await fixture();
  const options = { nodeBytes: 64, viewBytes: 300, compress: async () => "summary" };
  let state = await f.open(options);
  await state.main.commit(async (tx) => {
    for (let i = 0; i < 8; i++)
      await tx.appendEntry(state.main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "x".repeat(40), timestamp: i + 1 }],
      });
  }, context);
  await state.memory.prepare();
  await state.main.commit(async (tx) => {
    const draft = await tx.doc(MemoryIndexDoc, state.main.id);
    // A partial batch is below 300 bytes but still above its 150-byte target.
    draft.parts = [
      { start: 0, count: 4 },
      ...Array.from({ length: 4 }, (_, i) => ({ start: i + 4, count: 1 })),
    ];
    draft.merging = true;
  }, context);
  await state.memory.close();
  await state.harness.close(context);
  state = await f.open(options);
  cleanup.push(async () => {
    await state.memory.close();
    await state.harness.close(context);
  });
  expect((await state.harness.snapshot(MemoryIndexDoc, state.main.id, context))?.merging).toBe(
    true,
  );
  await state.main.commit(
    (tx) =>
      tx.appendEntry(state.main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "new", timestamp: 9 }],
      }),
    context,
  );
  await state.memory.prepare();
  const index = (await state.harness.snapshot(MemoryIndexDoc, state.main.id, context))!;
  expect(index.merging).toBe(false);
  const texts = await Promise.all(
    index.parts.map((part) =>
      state.harness.snapshot(MemoryNodesDoc, state.main.id, `${part.start}+${part.count}`, context),
    ),
  );
  expect(texts.reduce((sum, node) => sum + utf8Bytes(node!.text), 0)).toBeLessThanOrEqual(150);
  expect(await state.memory.zoom(0, 1)).toContain("x".repeat(40));
});

test("silent old and future turns keep IDs and originals but leave prepared memory", async () => {
  const fixtureState = await fixture();
  let state = await fixtureState.open();
  await state.main.commit(async (tx) => {
    await tx.appendEntry(state.main.id, {
      kind: "pi.assistant",
      model: [fauxAssistantMessage([fauxText("NO_REPLY")])],
    });
    await tx.appendEntry(state.main.id, {
      kind: "pi.user",
      model: [{ role: "user", content: "keep useful decision", timestamp: 123 }],
    });
  }, context);
  expect(await state.memory.prepare()).not.toContain("NO_REPLY");
  const original = await state.memory.zoom(0, 1);
  const originalDate = await state.memory.date(0);
  const sourceEntries = (await state.main.entries({}, 100, undefined, context)).items;
  await state.main.commit(async (tx) => {
    // Simulate a legacy tree created before the persistent maintenance checkpoint.
    await tx.retireDoc(MemoryMaintenanceDoc, state.main.id);
    (await tx.doc(MemoryNodesDoc, state.main.id, "0+1", { text: "" })).text = "talk: NO_REPLY";
    (await tx.doc(MemoryNodesDoc, state.main.id, "0+2", { text: "" })).text =
      "talk: NO_REPLY; user: useful";
  }, context);
  const calls = fixtureState.compressions();
  await state.memory.close();
  await state.harness.close(context);
  state = await fixtureState.open();
  cleanup.push(async () => {
    await state.memory.close();
    await state.harness.close(context);
  });
  expect(await state.memory.prepare()).not.toContain("NO_REPLY");
  expect(fixtureState.compressions()).toBe(calls);
  expect(await state.memory.zoom(0, 1)).toBe(original);
  expect(await state.memory.date(0)).toBe(originalDate);
  expect(await state.memory.zoom(1, 1)).toContain("keep useful decision");
  expect((await state.main.entries({}, 100, undefined, context)).items).toEqual(sourceEntries);
  expect((await state.memory.browserNode(0, 2)).children[0]?.summary).toContain("noise excluded");
  expect((await state.memory.browserNode(0, 1)).text).toContain("NO_REPLY");
  await state.main.commit(
    (tx) =>
      tx.appendEntry(state.main.id, {
        kind: "pi.assistant",
        model: [fauxAssistantMessage([fauxText("NO_REPLY")])],
      }),
    context,
  );
  expect(await state.memory.prepare()).not.toContain("NO_REPLY");
  expect(await state.memory.zoom(2, 1)).toContain("NO_REPLY");
  expect(await state.memory.zoom(1, 1)).toContain("keep useful decision");
});

test("restart resumes an unfinished ancestor from durable children", async () => {
  const f = await fixture();
  const cancellation = withCancel(context);
  let state = await f.open({
    compress: async (_, signal) => {
      cancellation.cancel(new Error("interrupt parent"));
      signal!.throwIfAborted();
      return "unreachable";
    },
  });
  await state.main.commit(async (tx) => {
    for (let i = 0; i < 2; i++)
      await tx.appendEntry(state.main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: `${i}:${"x".repeat(50)}`, timestamp: i + 1 }],
      });
  }, context);
  await expect(state.memory.prepare(cancellation.context)).rejects.toThrow("interrupt parent");
  expect(
    (await state.harness.snapshot(MemoryNodesDoc, state.main.id, "1+1", context))?.text,
  ).toContain("user: 1:");
  expect(
    await state.harness.snapshot(MemoryNodesDoc, state.main.id, "0+2", context),
  ).toBeUndefined();
  await state.memory.close();
  await state.harness.close(context);
  state = await f.open();
  cleanup.push(async () => {
    await state.memory.close();
    await state.harness.close(context);
  });
  await state.memory.prepare();
  expect(f.compressions()).toBe(1);
  expect(await state.memory.zoom(0, 2)).toContain("user: 1:");
  expect(state.memory.status().settled).toBe(2);
});

test("same-process retry publishes a final checkpoint cancelled after the last node", async () => {
  const f = await fixture();
  const cancellation = withCancel(context);
  let armed = false;
  const state = await f.open({
    onProgress: () => {
      if (armed) cancellation.cancel(new Error("cancel checkpoint"));
    },
  });
  cleanup.push(async () => {
    await state.memory.close();
    await state.harness.close(context);
  });
  await state.main.commit(
    (tx) =>
      tx.appendEntry(state.main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "decision after checkpoint", timestamp: 1 }],
      }),
    context,
  );
  armed = true;
  await expect(state.memory.prepare(cancellation.context)).rejects.toThrow("cancel checkpoint");
  // All nodes are built, but publishing their view still needs to be retried.
  expect(state.memory.status().pending).toBe(1);
  armed = false;
  expect(await state.memory.prepare()).toContain("decision after checkpoint");
  expect((await state.memory.browserOverview()).nodes[0]?.summary).toContain(
    "decision after checkpoint",
  );
});
