import { expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { MemoryNodesDoc, MemoryIndexDoc, Rebuild } from "./memory-documents";
import { fixture, cleanup } from "./memory-test-fixture";

test("full rebuild derives a fresh generation only from originals, preserves IDs and catches up tail", async () => {
  const f = await fixture();
  const state = await f.open();
  cleanup.push(async () => {
    await state.memory.close();
    await state.harness.close(context);
  });
  await state.main.commit(async (tx) => {
    await tx.appendEntry(state.main.id, {
      kind: "pi.assistant",
      model: [fauxAssistantMessage([fauxText("NO_REPLY")])],
    });
    for (let i = 0; i < 3; i++)
      await tx.appendEntry(state.main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: `source ${i} ${"x".repeat(120)}`, timestamp: i + 1 }],
      });
  }, context);
  await state.memory.prepare();
  const exact = await state.memory.zoom(1, 1);
  await state.main.commit(async (tx) => {
    (await tx.doc(MemoryNodesDoc, state.main.id, "1+1", { text: "" })).text = "CONTAMINATED";
    (await tx.doc(MemoryNodesDoc, state.main.id, "0+4", { text: "" })).text = "CONTAMINATED";
  }, context);
  await state.memory.rebuild();
  expect(await state.memory.prepare()).not.toContain("CONTAMINATED");
  expect(await state.memory.zoom(1, 1)).toBe(exact);
  expect(await state.memory.zoom(0, 1)).toContain("NO_REPLY");
  expect(await state.memory.prepare()).not.toContain("NO_REPLY");
  expect(
    (await state.harness.snapshot(MemoryNodesDoc, state.main.id, "g1:1+1", context))?.text,
  ).toContain("source 0");
  // The old generation is retained, rather than destructively edited by rebuild.
  expect((await state.harness.snapshot(MemoryNodesDoc, state.main.id, "1+1", context))?.text).toBe(
    "CONTAMINATED",
  );
  const calls = f.compressions();
  await state.memory.rebuild();
  expect(f.compressions()).toBe(calls);
  await state.main.commit(
    (tx) =>
      tx.appendEntry(state.main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "new decision", timestamp: 42 }],
      }),
    context,
  );
  await state.memory.prepare();
  expect(await state.memory.zoom(4, 1)).toContain("new decision");
  expect(
    (await state.harness.snapshot(MemoryNodesDoc, state.main.id, "g1:4+1", context))?.text,
  ).toContain("new decision");
});

test("resume honors persisted repairs while accepting complete oversized candidates", async () => {
  const f = await fixture();
  let state = await f.open({
    compress: async (source) =>
      source.includes("valid child") ? "ø".repeat(41) : `repaired child ${"x".repeat(60)}`,
  });
  cleanup.push(async () => {
    await state.memory.close();
    await state.harness.close(context);
  });
  await state.main.commit(async (tx) => {
    for (let i = 0; i < 2; i++)
      await tx.appendEntry(state.main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: `decision ${i} ${"x".repeat(100)}`, timestamp: i }],
      });
  }, context);
  await state.memory.prepare();
  const original = await state.memory.zoom(0, 1);
  await state.main.commit(async (tx) => {
    Object.assign(await tx.doc(Rebuild, state.main.id), {
      generation: 1,
      total: 2,
      status: "pending",
      level: 4,
      repairs: ["0+1", "0+2"],
    });
    (await tx.doc(MemoryNodesDoc, state.main.id, "g1:0+1", { text: "" })).text = "ø".repeat(50);
    (await tx.doc(MemoryNodesDoc, state.main.id, "g1:1+1", { text: "" })).text = "valid child";
    (await tx.doc(MemoryNodesDoc, state.main.id, "g1:0+2", { text: "" })).text = "STALE PARENT";
  }, context);
  await state.memory.rebuild();
  expect(
    (await state.harness.snapshot(MemoryNodesDoc, state.main.id, "g1:0+1", context))?.text,
  ).toBe(`repaired child ${"x".repeat(60)}`);
  expect((await state.harness.snapshot(MemoryIndexDoc, state.main.id, context))?.generation).toBe(
    1,
  );
  await state.memory.close();
  await state.harness.close(context);
  state = await f.open();
  await state.memory.rebuild();
  expect((await state.harness.snapshot(MemoryIndexDoc, state.main.id, context))?.generation).toBe(
    1,
  );
  for (const key of ["g1:0+1", "g1:1+1", "g1:0+2"]) {
    const node = await state.harness.snapshot(MemoryNodesDoc, state.main.id, key, context);
    expect(node!.text).not.toContain("STALE PARENT");
  }
  expect(await state.memory.zoom(0, 1)).toBe(original);
});

test("oversize custom compression completes rebuild and publishes the shortest complete candidate", async () => {
  const f = await fixture();
  let fail = false;
  const state = await f.open({ compress: async () => (fail ? "ø".repeat(41) : "valid summary") });
  cleanup.push(async () => {
    await state.memory.close();
    await state.harness.close(context);
  });
  await state.main.commit(
    (tx) =>
      tx.appendEntry(state.main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "source ".repeat(30), timestamp: 1 }],
      }),
    context,
  );
  await state.memory.prepare();
  fail = true;
  await state.memory.rebuild();
  expect((await state.harness.snapshot(MemoryIndexDoc, state.main.id, context))?.generation).toBe(
    1,
  );
  expect(
    (await state.harness.snapshot(MemoryNodesDoc, state.main.id, "g1:0+1", context))?.text,
  ).toBe("ø".repeat(41));
  fail = false;
  await state.memory.rebuild();
  expect((await state.harness.snapshot(MemoryIndexDoc, state.main.id, context))?.generation).toBe(
    1,
  );
});

test("generation publication includes originals admitted while rebuilding and survives reopen", async () => {
  const f = await fixture();
  let gated = false;
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let state = await f.open({
    compress: async (source) => {
      if (gated && source.startsWith("user: older")) {
        entered();
        await gate;
      }
      return `summary ${source.slice(0, 45)}`;
    },
  });
  await state.main.commit(
    (tx) =>
      tx.appendEntry(state.main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: `older ${"x".repeat(120)}`, timestamp: 1 }],
      }),
    context,
  );
  await state.memory.prepare();
  const date = await state.memory.date(0);
  gated = true;
  const rebuilding = state.memory.rebuild();
  await ready;
  await state.main.commit(
    (tx) =>
      tx.appendEntry(state.main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "concurrent new decision", timestamp: 2 }],
      }),
    context,
  );
  // Live old generation remains usable and can admit new messages throughout.
  expect(await state.memory.prepare()).toContain("concurrent new decision");
  release();
  await rebuilding;
  expect(await state.memory.date(0)).toBe(date);
  expect(await state.memory.zoom(1, 1)).toContain("concurrent new decision");
  expect(
    (await state.harness.snapshot(MemoryNodesDoc, state.main.id, "g1:1+1", context))?.text,
  ).toContain("concurrent new decision");
  await state.memory.close();
  await state.harness.close(context);
  state = await f.open();
  cleanup.push(async () => {
    await state.memory.close();
    await state.harness.close(context);
  });
  expect(await state.memory.prepare()).toContain("concurrent new decision");
  expect(await state.memory.zoom(1, 1)).toContain("concurrent new decision");
  expect(await state.memory.date(0)).toBe(date);
});

test("interrupted rebuild resumes persisted fresh nodes without publishing a partial generation", async () => {
  const f = await fixture();
  let state = await f.open();
  await state.main.commit(async (tx) => {
    await tx.appendEntry(state.main.id, {
      kind: "pi.assistant",
      model: [fauxAssistantMessage([fauxText("NO_REPLY")])],
    });
    await tx.appendEntry(state.main.id, {
      kind: "pi.user",
      model: [{ role: "user", content: "x".repeat(200), timestamp: 1 }],
    });
  }, context);
  const before = await state.memory.prepare();
  await state.memory.close();
  await state.harness.close(context);
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  state = await f.open({
    compress: async (_, signal) => {
      entered();
      await new Promise((_, reject) =>
        signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }),
      );
      return "unreachable";
    },
  });
  const pending = state.memory.rebuild().catch(() => undefined);
  await enteredPromise;
  expect(
    (await state.memory.browserOverview()).nodes.map((node) => node.summary).join("\n"),
  ).toContain("summary");
  await state.memory.close().catch(() => undefined);
  await pending;
  await state.harness.close(context);
  state = await f.open();
  cleanup.push(async () => {
    await state.memory.close();
    await state.harness.close(context);
  });
  expect(await state.memory.prepare()).toBe(before);
  await state.memory.rebuild();
  expect(
    (await state.harness.snapshot(MemoryNodesDoc, state.main.id, "g1:0+1", context))?.text,
  ).toBe("");
  expect(
    (await state.harness.snapshot(MemoryNodesDoc, state.main.id, "g1:1+1", context))?.text,
  ).toContain("summary");
  expect(await state.memory.zoom(1, 1)).toContain("x".repeat(200));
});
