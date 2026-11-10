import { expect, test, vi } from "vite-plus/test";
import { rpcEvents, splitByteStream } from "./streams";

function bytes(...chunks: number[][]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Uint8Array.from(chunk));
      controller.close();
    },
  });
}

async function collect(
  body: ReadableStream<Uint8Array>,
  sizes: number[],
  signal = new AbortController().signal,
) {
  const files: number[][] = [];
  for await (const part of splitByteStream(body, sizes, signal)) {
    const file: number[] = [];
    for await (const chunk of part) file.push(...chunk);
    files.push(file);
  }
  return files;
}

test("manifest boundaries are independent of transport chunks and include empty files", async () => {
  expect(await collect(bytes([], [1, 2, 3], [4], [5, 6]), [0, 2, 0, 3, 1, 0])).toEqual([
    [],
    [1, 2],
    [],
    [3, 4, 5],
    [6],
    [],
  ]);
});

test("empty trailing chunks are not file bytes", async () => {
  expect(await collect(bytes([1], [], []), [1])).toEqual([[1]]);
  expect(await collect(bytes([], []), [])).toEqual([]);
  await expect(collect(bytes([1], [], [2]), [1])).rejects.toMatchObject({ code: "BAD_INPUT" });
});

test("source failures release the lock and preserve the original error", async () => {
  const reason = new Error("source failed");
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(reason);
    },
  });
  await expect(collect(body, [1])).rejects.toBe(reason);
  expect(body.locked).toBe(false);
});

test("abort preserves its reason even when source cancellation rejects", async () => {
  const controller = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      throw new Error("cleanup failed");
    },
  });
  const reading = collect(body, [1], controller.signal);
  await Promise.resolve();
  const reason = new Error("abort");
  controller.abort(reason);
  await expect(reading).rejects.toBe(reason);
  expect(body.locked).toBe(false);
});

test("missing and excess bytes reject instead of truncating files", async () => {
  await expect(collect(bytes([1]), [2])).rejects.toMatchObject({ code: "BAD_INPUT" });
  await expect(collect(bytes([1, 2]), [1])).rejects.toMatchObject({ code: "BAD_INPUT" });
  await expect(collect(bytes([1], [2]), [1])).rejects.toMatchObject({ code: "BAD_INPUT" });
  await expect(collect(bytes([1]), [])).rejects.toMatchObject({ code: "BAD_INPUT" });
  expect(await collect(bytes(), [])).toEqual([]);
});

test("abort interrupts a pending byte read and releases the source lock", async () => {
  const cancelled = vi.fn();
  const body = new ReadableStream<Uint8Array>({ cancel: cancelled });
  const controller = new AbortController();
  const reading = collect(body, [1], controller.signal);
  const reason = new Error("cancelled upload");
  await Promise.resolve();
  controller.abort(reason);
  await expect(reading).rejects.toBe(reason);
  expect(cancelled).toHaveBeenCalledWith(reason);
  expect(body.locked).toBe(false);
});

test("abandoning a file part cancels the remaining byte body", async () => {
  const cancelled = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.from([1, 2, 3]));
    },
    cancel: cancelled,
  });
  for await (const part of splitByteStream(body, [3], new AbortController().signal)) {
    for await (const _chunk of part) break;
    break;
  }
  expect(cancelled).toHaveBeenCalledOnce();
  expect(body.locked).toBe(false);
});

test("early break surfaces cancellation failure and releases the source lock", async () => {
  const reason = new Error("cancellation failed");
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      throw reason;
    },
  });
  const consuming = (async () => {
    for await (const _part of splitByteStream(body, [1], new AbortController().signal)) break;
  })();
  await expect(consuming).rejects.toBe(reason);
  expect(body.locked).toBe(false);
});

test("event producers wait for demand and cancellation unblocks queued emissions", async () => {
  let emit!: (event: number) => Promise<void>;
  let lifetime!: AbortSignal;
  const stop = vi.fn();
  const stream = rpcEvents<number>(new AbortController().signal, (publish, signal) => {
    emit = publish;
    lifetime = signal;
    return stop;
  });
  const reader = stream.getReader();
  let sent = false;
  const first = emit(1).then(() => {
    sent = true;
  });
  await Promise.resolve();
  expect(sent).toBe(false);
  expect(await reader.read()).toEqual({ value: 1, done: false });
  await first;
  const second = emit(2);
  await reader.cancel();
  await second;
  expect(lifetime.aborted).toBe(true);
  expect(stop).toHaveBeenCalledOnce();
});

test("subscription failure errors the reader and cleans up a synchronously ended subscription", async () => {
  const reason = new Error("subscription failed");
  const stop = vi.fn();
  const stream = rpcEvents(new AbortController().signal, (_emit, _signal, fail) => {
    fail(reason);
    return stop;
  });
  await expect(stream.getReader().read()).rejects.toBe(reason);
  expect(stop).toHaveBeenCalledOnce();
});

test("aborted subscriptions do not start; active abort closes pending reads", async () => {
  const controller = new AbortController();
  const subscribe = vi.fn(() => vi.fn());
  controller.abort();
  expect(await rpcEvents(controller.signal, subscribe).getReader().read()).toEqual({
    value: undefined,
    done: true,
  });
  expect(subscribe).not.toHaveBeenCalled();
  const active = new AbortController();
  const stop = vi.fn();
  const reader = rpcEvents(active.signal, () => stop).getReader();
  const reading = reader.read();
  active.abort();
  expect(await reading).toEqual({ value: undefined, done: true });
  expect(stop).toHaveBeenCalledOnce();
});
