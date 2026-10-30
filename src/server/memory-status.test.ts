import { expect, test, vi } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { MemoryFatalError } from "./memory-compression";
import { cleanup, fixture } from "./memory-test-fixture";

function gate() {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, release: resolve };
}

test("background failure leaves the successful main task intact and clears only after memory catches up", async () => {
  const f = await fixture();
  let failing = true;
  let holdMerge = true;
  const mergeStarted = gate();
  const merge = gate();
  const errors: string[] = [];
  const state = await f.open({
    nodeBytes: 80,
    compress: async (source) => {
      if (failing) throw new MemoryFatalError("Invalid prompt");
      if (source.includes("summary") && holdMerge) {
        mergeStarted.release();
        await merge.promise;
      }
      return `summary ${"x".repeat(50)}`;
    },
    onError: (error) => errors.push(String(error)),
  });
  cleanup.push(async () => {
    merge.release();
    await state.memory.close();
    await state.harness.close(context);
  });
  f.faux.setResponses([
    fauxAssistantMessage([fauxText("first answer ".repeat(20))]),
    fauxAssistantMessage([fauxText("second answer ".repeat(20))]),
  ]);
  const first = await state.main.submit(
    { type: "input", content: "first input ".repeat(20) },
    context,
  );
  expect((await first.wait(context)).status).toBe("done");
  await state.memory.sync();
  await expect(state.memory.settle()).rejects.toThrow("Invalid prompt");
  await vi.waitFor(() => expect(state.memory.status().error).toContain("Invalid prompt"));
  expect(state.memory.status().pending).toBeGreaterThan(0);
  expect(errors).toHaveLength(1);
  failing = false;
  const second = await state.main.submit({ type: "input", content: "continue" }, context);
  expect((await second.wait(context)).status).toBe("done");
  await state.memory.sync();
  const settling = state.memory.settle();
  await mergeStarted.promise;
  // Successful leaf writes must not hide an error while the failed prefix is unpublished.
  expect(state.memory.status().error).toContain("Invalid prompt");
  expect(state.memory.status().pending).toBeGreaterThan(0);
  holdMerge = false;
  merge.release();
  await settling;
  await vi.waitFor(() => {
    expect(state.memory.status().pending).toBe(0);
    expect(state.memory.status().error).toBeUndefined();
  });
  expect((await first.status(context)).status).toBe("done");
  expect(errors).toEqual(["Error: Invalid prompt"]);
});

test("cached nodes clear a publication error when the prefix is successfully settled", async () => {
  const f = await fixture();
  let failPublication = true;
  const errors: string[] = [];
  const state = await f.open({
    onProgress: () => {
      if (failPublication) throw new Error("Publication interrupted");
    },
    onError: (error) => errors.push(String(error)),
  });
  cleanup.push(async () => {
    await state.memory.close();
    await state.harness.close(context);
  });
  f.faux.setResponses([fauxAssistantMessage([fauxText("answer ".repeat(30))])]);
  expect(
    (
      await (
        await state.main.submit({ type: "input", content: "input ".repeat(30) }, context)
      ).wait(context)
    ).status,
  ).toBe("done");
  await state.memory.sync();
  await expect(state.memory.settle()).rejects.toThrow("Publication interrupted");
  await vi.waitFor(() => expect(state.memory.status().error).toContain("Publication interrupted"));
  const compressions = f.compressions();
  failPublication = false;
  await state.memory.settle();
  expect(f.compressions()).toBe(compressions);
  expect(state.memory.status()).toMatchObject({ pending: 0, error: undefined });
  expect(errors).toEqual(["Error: Publication interrupted"]);
});

test("a recovered retry clears its error after successful maintenance", async () => {
  const f = await fixture();
  const retryStarted = gate();
  const retry = gate();
  let calls = 0;
  const state = await f.open({
    retryMs: 1,
    compress: async () => {
      if (++calls === 1) throw new Error("Temporary failure");
      retryStarted.release();
      await retry.promise;
      return "summary";
    },
    onError: () => {},
  });
  cleanup.push(async () => {
    retry.release();
    await state.memory.close();
    await state.harness.close(context);
  });
  await state.main.commit(
    (tx) =>
      tx.appendEntry(state.main.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "original ".repeat(30), timestamp: 1 }],
      }),
    context,
  );
  const prepared = state.memory.prepare();
  await retryStarted.promise;
  expect(state.memory.status().error).toContain("Temporary failure");
  retry.release();
  await prepared;
  expect(state.memory.status()).toMatchObject({ pending: 0, error: undefined });
  await state.memory.settle();
  expect(calls).toBe(2);
  expect(state.memory.status().error).toBeUndefined();
});
