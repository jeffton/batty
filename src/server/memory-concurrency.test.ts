import { expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { GenerationTask, defineExtension, defineTool, hook } from "@earendil-works/pi-durable";
import { Packets, MemoryIndexDoc, SessionMemory } from "./memory-documents";
import { snapshotFromView, snapshotView } from "./memory-snapshot";
import { fixture, cleanup } from "./memory-test-fixture";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function view(messages: readonly { role: string; content: unknown }[]) {
  return messages.find(
    (message) => message.role === "user" && String(message.content).startsWith("<chat>"),
  )!.content as string;
}

async function pinArchive(state: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["open"]>>) {
  const overview = await state.memory.prepare();
  const entries = await state.main.entries({}, 1, undefined, context);
  const boundary = Number(entries.items[0]!.id) + 1;
  await state.main.commit(async (tx) => {
    Object.assign(await tx.doc(SessionMemory, state.main.id), {
      boundary,
      view: snapshotView(overview, {
        generation: 0,
        count: state.memory.status().totalLeaves,
        prepared: state.memory.status().builtLeaves,
      }),
      snapshot: {
        generation: 0,
        count: state.memory.status().totalLeaves,
        prepared: state.memory.status().builtLeaves,
      },
    });
  }, context);
}

test("new main runs finish with native originals while maintenance is still compressing", async () => {
  const f = await fixture();
  const started = gate(),
    blocked = gate();
  let held = false;
  const state = await f.open({
    viewBytes: 10_000,
    compress: async (source) => {
      if (held) {
        started.release();
        await blocked.promise;
      }
      return `summary ${source.slice(0, 35)}`;
    },
  });
  cleanup.push(async () => {
    blocked.release();
    await state.memory.close();
    await state.harness.close(context);
  });
  await state.main.commit(
    (tx) =>
      tx.appendEntry(state.main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "established decision", timestamp: 1 }],
      }),
    context,
  );
  await state.memory.prepare();
  const raw = `fresh decision ${"x".repeat(140_000)}`;
  await state.main.commit(
    (tx) =>
      tx.appendEntry(state.main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: raw, timestamp: 2 }],
      }),
    context,
  );
  await state.memory.sync();
  held = true;
  const maintenance = state.memory.settle();
  await started.promise;
  const requests: string[] = [];
  f.faux.setResponses(
    Array.from({ length: 2 }, () => (request) => {
      const originals = request.messages.filter((message) => message.role !== "system");
      expect(originals).toContainEqual(
        expect.objectContaining({ role: "user", content: "established decision", timestamp: 1 }),
      );
      expect(originals).toContainEqual(
        expect.objectContaining({ role: "user", content: raw, timestamp: 2 }),
      );
      expect(view(request.messages)).not.toContain("not summarized yet");
      requests.push(JSON.stringify(originals));
      return fauxAssistantMessage([fauxText("answered before maintenance finished")]);
    }),
  );
  for (const content of ["first new input", "second new input"])
    expect(
      (await (await state.main.submit({ type: "input", content }, context)).wait(context)).status,
    ).toBe("done");
  expect(requests).toHaveLength(2);
  expect(state.memory.status().settled).toBe(1);
  blocked.release();
  await maintenance;
});

test("new main input is answered before a slow repair publishes its replacement generation", async () => {
  const f = await fixture();
  const started = gate(),
    blocked = gate();
  const state = await f.open({
    viewBytes: 10_000,
    nodeBytes: 512,
    compress: async () => {
      started.release();
      await blocked.promise;
      return "repaired summary";
    },
  });
  cleanup.push(async () => {
    blocked.release();
    await state.memory.close();
    await state.harness.close(context);
  });
  for (let id = 0; id < 4; id++)
    await state.main.commit(
      (tx) =>
        tx.appendEntry(state.main.id, {
          kind: "pi.user",
          model: [{ role: "user", content: `original ${id}`, timestamp: id + 1 }],
        }),
      context,
    );
  await state.memory.prepare();
  const repair = state.memory.repair([{ start: 0, count: 2 }], 0);
  await started.promise;
  f.faux.setResponses([
    (request) => {
      expect(snapshotFromView(view(request.messages))?.generation).toBe(0);
      expect(request.messages).toContainEqual(
        expect.objectContaining({ role: "user", content: "original 0", timestamp: 1 }),
      );
      return fauxAssistantMessage([fauxText("answered before repair finished")]);
    },
  ]);
  expect(
    (
      await (
        await state.main.submit({ type: "input", content: "new input" }, context)
      ).wait(context)
    ).status,
  ).toBe("done");
  expect(
    (await state.harness.snapshot(MemoryIndexDoc, state.main.id, context))?.generation ?? 0,
  ).toBe(0);
  blocked.release();
  expect((await repair).generation).toBe(1);
});

test("over-threshold history remains available without waiting for background archival", async () => {
  const f = await fixture();
  const started = gate(),
    blocked = gate();
  const state = await f.open({
    viewBytes: 100,
    sessionTailBytes: 1_000,
    compress: async () => {
      started.release();
      await blocked.promise;
      return "retained decision";
    },
  });
  cleanup.push(async () => {
    blocked.release();
    await state.memory.close();
    await state.harness.close(context);
  });
  await state.main.commit(
    (tx) =>
      tx.appendEntry(state.main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "large original ".repeat(2000), timestamp: 1 }],
      }),
    context,
  );
  let called = false;
  f.faux.setResponses([
    (request) => {
      called = true;
      expect(request.messages).toContainEqual(
        expect.objectContaining({
          role: "user",
          content: "large original ".repeat(2000),
          timestamp: 1,
        }),
      );
      expect(view(request.messages)).not.toContain("retained decision");
      return fauxAssistantMessage([fauxText("done")]);
    },
  ]);
  const submission = await state.main.submit({ type: "input", content: "continue" }, context);
  await started.promise;
  expect((await submission.wait(context)).status).toBe("done");
  expect(called).toBe(true);
  expect((await state.harness.snapshot(SessionMemory, state.main.id, context))?.boundary).toBe(0);
  blocked.release();
});

test("a published tree indexed past the run boundary cannot leak later entries into its packet", async () => {
  const f = await fixture();
  const state = await f.open({ viewBytes: 10_000, nodeBytes: 512 });
  const started = gate(),
    blocked = gate();
  state.registry.install(
    defineExtension({
      name: "delay-request",
      hooks: [
        hook(GenerationTask, {
          beforeRequest: async () => {
            started.release();
            await blocked.promise;
          },
        }),
      ],
    }),
  );
  // Hooks run in registry order; move memory behind this test's admission gate.
  state.registry.uninstall(state.memory.extension);
  state.registry.install(state.memory.extension);
  cleanup.push(async () => {
    blocked.release();
    await state.memory.close();
    await state.harness.close(context);
  });
  for (let id = 0; id < 2; id++)
    await state.main.commit(
      (tx) =>
        tx.appendEntry(state.main.id, {
          kind: "pi.user",
          model: [{ role: "user", content: `prior ${id}`, timestamp: id + 1 }],
        }),
      context,
    );
  const submission = await state.main.submit({ type: "input", content: "current input" }, context);
  await started.promise;
  await state.main.commit(
    (tx) =>
      tx.appendEntry(state.main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "future secret", timestamp: 10 }],
      }),
    context,
  );
  await state.memory.prepare();
  f.faux.setResponses([
    (request) => {
      const packet = view(request.messages);
      expect(request.messages).toContainEqual(
        expect.objectContaining({ role: "user", content: "prior 0", timestamp: 1 }),
      );
      expect(request.messages).toContainEqual(
        expect.objectContaining({ role: "user", content: "prior 1", timestamp: 2 }),
      );
      expect(packet).not.toContain("current input");
      expect(packet).not.toContain("future secret");
      expect(JSON.stringify(request.messages)).not.toContain("future secret");
      return fauxAssistantMessage([fauxText("done")]);
    },
  ]);
  blocked.release();
  expect((await submission.wait(context)).status).toBe("done");
});

test("repair leaves the run's zoom tree and later session packets pinned until rollover", async () => {
  const f = await fixture();
  const state = await f.open({
    viewBytes: 10_000,
    nodeBytes: 512,
    compress: async () => "repaired summary",
  });
  cleanup.push(async () => {
    await state.memory.close();
    await state.harness.close(context);
  });
  for (let id = 0; id < 4; id++)
    await state.main.commit(
      (tx) =>
        tx.appendEntry(state.main.id, {
          kind: "pi.user",
          model: [{ role: "user", content: `original ${id}`, timestamp: id + 1 }],
        }),
      context,
    );
  await pinArchive(state);
  state.registry.install(
    defineExtension({
      name: "repair-during-run",
      tools: [
        defineTool({
          name: "repair_tree",
          description: "repair",
          parameters: Type.Object({}),
          replay: "safe",
          execute: async () => {
            await state.memory.repair([{ start: 0, count: 2 }], 0);
            return { output: [{ type: "text", text: "repaired" }] };
          },
        }),
      ],
    }),
  );
  const packets: string[] = [];
  f.faux.setResponses([
    (request) => {
      packets.push(view(request.messages));
      return fauxAssistantMessage([fauxToolCall("repair_tree", {})], { stopReason: "toolUse" });
    },
    (request) => {
      packets.push(view(request.messages));
      return fauxAssistantMessage([fauxToolCall("memory_zoom", { id: 0, n: 4 })], {
        stopReason: "toolUse",
      });
    },
    (request) => {
      packets.push(view(request.messages));
      const result = request.messages.findLast((message) => message.role === "toolResult")!;
      expect(JSON.stringify(result)).toContain("original 0");
      expect(JSON.stringify(result)).not.toContain("repaired summary");
      return fauxAssistantMessage([fauxText("done")]);
    },
    (request) => {
      packets.push(view(request.messages));
      return fauxAssistantMessage([fauxToolCall("memory_zoom", { id: 0, n: 4 })], {
        stopReason: "toolUse",
      });
    },
    (request) => {
      expect(
        JSON.stringify(request.messages.findLast((message) => message.role === "toolResult")),
      ).not.toContain("repaired summary");
      expect(
        JSON.stringify(request.messages.findLast((message) => message.role === "toolResult")),
      ).toContain("original 0");
      return fauxAssistantMessage([fauxText("done")]);
    },
  ]);
  expect(
    (
      await (
        await state.main.submit({ type: "input", content: "repair and inspect" }, context)
      ).wait(context)
    ).status,
  ).toBe("done");
  expect(packets[0]).toBe(packets[1]);
  expect(packets[0]).toBe(packets[2]);
  expect(snapshotFromView(packets[0]!)?.generation).toBe(0);
  expect(
    (
      await (
        await state.main.submit({ type: "input", content: "inspect repaired tree" }, context)
      ).wait(context)
    ).status,
  ).toBe("done");
  expect(snapshotFromView(packets[3]!)?.generation).toBe(0);
  expect(packets[3]).toBe(packets[0]);
  expect((await state.harness.snapshot(MemoryIndexDoc, state.main.id, context))?.generation).toBe(
    1,
  );
});

test("reopen resumes a run using its persisted packet despite a repair between model turns", async () => {
  const f = await fixture();
  let state = await f.open({
    viewBytes: 10_000,
    nodeBytes: 512,
    compress: async () => "repaired summary",
  });
  for (let id = 0; id < 2; id++)
    await state.main.commit(
      (tx) =>
        tx.appendEntry(state.main.id, {
          kind: "pi.user",
          model: [{ role: "user", content: `original ${id}`, timestamp: id + 1 }],
        }),
      context,
    );
  await pinArchive(state);
  const started = gate();
  let firstView = "";
  state.registry.install(
    defineExtension({
      name: "durable-pause",
      tools: [
        defineTool({
          name: "pause",
          description: "pause",
          parameters: Type.Object({}),
          replay: "safe",
          execute: async (_, __, ctx) => {
            await state.memory.repair([{ start: 0, count: 2 }], 0);
            started.release();
            await new Promise<void>((_, reject) =>
              ctx.abortSignal!.addEventListener("abort", () => reject(ctx.abortSignal!.reason), {
                once: true,
              }),
            );
            return {};
          },
        }),
      ],
    }),
  );
  f.faux.setResponses([
    (request) => {
      firstView = view(request.messages);
      return fauxAssistantMessage([fauxToolCall("pause", {})], { stopReason: "toolUse" });
    },
  ]);
  const submission = await state.main.submit({ type: "input", content: "durable input" }, context);
  await started.promise;
  expect((await state.harness.snapshot(MemoryIndexDoc, state.main.id, context))?.generation).toBe(
    1,
  );
  await state.harness.close(context);
  await state.memory.close();
  state = await f.open({ viewBytes: 10_000, nodeBytes: 512 });
  cleanup.push(async () => {
    await state.memory.close();
    await state.harness.close(context);
  });
  state.registry.install(
    defineExtension({
      name: "durable-pause",
      tools: [
        defineTool({
          name: "pause",
          description: "pause",
          parameters: Type.Object({}),
          replay: "safe",
          execute: async () => ({ output: [{ type: "text", text: "resumed" }] }),
        }),
      ],
    }),
  );
  f.faux.setResponses([
    (request) => {
      expect(view(request.messages)).toBe(firstView);
      expect(snapshotFromView(view(request.messages))?.generation).toBe(0);
      return fauxAssistantMessage([fauxText("resumed answer")]);
    },
  ]);
  const resumed = (await state.harness.submission(submission.id, context))!;
  expect((await resumed.wait(context)).status).toBe("done");
  const packet = await state.harness.snapshot(
    Packets,
    state.main.id,
    String(submission.id),
    context,
  );
  expect(packet?.view).toBe(firstView);
  expect(packet?.snapshot.generation).toBe(0);
});
