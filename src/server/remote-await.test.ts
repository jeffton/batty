// @vitest-environment node
import { EventEmitter } from "node:events";
import type { ConversationId } from "@earendil-works/pi-durable";
import { expect, test, vi } from "vite-plus/test";
import { RemoteWorkers } from "./remote-workers";

type Status = { status: string; text?: string };
const input = {
  node: "mac",
  session: "12",
  assignmentId: "34",
  parentId: 1 as ConversationId,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Exercise join's scheduling independently of network transport and durable storage.
function fixture() {
  const changes = new EventEmitter();
  const assignment = vi.fn<(...args: unknown[]) => Promise<Status>>();
  const submit = vi.fn().mockResolvedValue(undefined);
  const receiver = {
    changes,
    assignment,
    runtime: { harness: { conversation: vi.fn().mockResolvedValue({ submit }) } },
  } as unknown as RemoteWorkers;
  const controller = new AbortController();
  return {
    changes,
    assignment,
    submit,
    controller,
    run: () => RemoteWorkers.prototype.join.call(receiver, input, controller.signal),
  };
}

async function settle() {
  // Flush asynchronous status checks and delivery without introducing a timer wakeup.
  for (let turn = 0; turn < 8; turn++) await Promise.resolve();
}

test("remote await stays idle without polling and wakes only for its peer catalog", async () => {
  vi.useFakeTimers();
  const state = fixture();
  state.assignment
    .mockResolvedValueOnce({ status: "running" })
    .mockResolvedValueOnce({ status: "completed", text: "assignment finished" });
  const pending = state.run();
  try {
    await settle();
    expect(state.assignment).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    state.changes.emit("change");
    state.changes.emit("catalog", "other-peer");
    await settle();
    expect(state.assignment).toHaveBeenCalledTimes(1);
    expect(state.submit).not.toHaveBeenCalled();
    // An assignment may finish while its worker is still active; no worker status is needed.
    state.changes.emit("catalog", "mac");
    await pending;
    expect(state.assignment).toHaveBeenCalledTimes(2);
    expect(state.submit).toHaveBeenCalledTimes(1);
    expect(state.submit.mock.calls[0]![0]).toMatchObject({
      requestId: "remote-result:mac:34:1",
    });
    expect(state.changes.listenerCount("catalog")).toBe(0);
  } finally {
    state.controller.abort();
    await pending.catch(() => {});
    vi.useRealTimers();
  }
});

test("catalog completion during initial status fetch is retained and bursts coalesce", async () => {
  const state = fixture();
  const initial = deferred<Status>();
  state.assignment
    .mockReturnValueOnce(initial.promise)
    .mockResolvedValueOnce({ status: "completed", text: "race recovered" });
  const pending = state.run();
  expect(state.assignment).toHaveBeenCalledTimes(1);
  for (let event = 0; event < 5; event++) state.changes.emit("catalog", "mac");
  initial.resolve({ status: "running" });
  await pending;
  expect(state.assignment).toHaveBeenCalledTimes(2);
  expect(state.submit).toHaveBeenCalledTimes(1);
  expect(state.changes.listenerCount("catalog")).toBe(0);
});

test("transport failure waits for reconnect snapshot and recovers a completion missed offline", async () => {
  const state = fixture();
  const offline = deferred<Status>();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  state.assignment
    .mockRejectedValueOnce(new Error("control stream disconnected"))
    .mockReturnValueOnce(offline.promise)
    .mockResolvedValueOnce({ status: "completed", text: "finished offline" });
  const pending = state.run();
  try {
    await settle();
    expect(state.assignment).toHaveBeenCalledTimes(1);
    // Reconnect may wake a status request whose response then reflects the old state.
    state.changes.emit("catalog", "mac");
    await settle();
    expect(state.assignment).toHaveBeenCalledTimes(2);
    state.changes.emit("catalog", "mac");
    offline.resolve({ status: "running" });
    await pending;
    expect(state.assignment).toHaveBeenCalledTimes(3);
    expect(state.submit).toHaveBeenCalledTimes(1);
    expect(state.changes.listenerCount("catalog")).toBe(0);
  } finally {
    state.controller.abort();
    await pending.catch(() => {});
    log.mockRestore();
  }
});

test("a failed final status fetch requests catalog resync without another remote commit", async () => {
  const state = fixture();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  state.assignment
    .mockResolvedValueOnce({ status: "running" })
    .mockRejectedValueOnce(new Error("single status HTTP 503"))
    .mockResolvedValueOnce({ status: "completed", text: "terminal assignment" });
  const resync = vi.fn((node: string) => {
    // A reconnected catalog sends a snapshot even when no worker commits follow.
    queueMicrotask(() => state.changes.emit("catalog", node));
  });
  state.changes.on("catalog-refresh", resync);
  const pending = state.run();
  try {
    await settle();
    state.changes.emit("catalog", "mac");
    await pending;
    expect(resync).toHaveBeenCalledExactlyOnceWith("mac");
    expect(state.assignment).toHaveBeenCalledTimes(3);
    expect(state.submit).toHaveBeenCalledTimes(1);
    expect(state.changes.listenerCount("catalog")).toBe(0);
  } finally {
    state.controller.abort();
    await pending.catch(() => {});
    state.changes.off("catalog-refresh", resync);
    log.mockRestore();
  }
});

test("abort releases idle wait and removes catalog and abort listeners", async () => {
  const state = fixture();
  const add = vi.spyOn(state.controller.signal, "addEventListener");
  const remove = vi.spyOn(state.controller.signal, "removeEventListener");
  state.assignment.mockResolvedValue({ status: "running" });
  const pending = state.run();
  const outcome = expect(pending).rejects.toThrow("cancelled await");
  await settle();
  state.controller.abort(new Error("cancelled await"));
  await outcome;
  expect(state.changes.listenerCount("catalog")).toBe(0);
  expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]![1]);
  state.changes.emit("catalog", "mac");
  await settle();
  expect(state.assignment).toHaveBeenCalledTimes(1);
  expect(state.submit).not.toHaveBeenCalled();
});

test("abort during status fetch cannot deliver its subsequent completion", async () => {
  const state = fixture();
  const status = deferred<Status>();
  state.assignment.mockReturnValue(status.promise);
  const pending = state.run();
  const outcome = expect(pending).rejects.toThrow("cancelled during fetch");
  state.controller.abort(new Error("cancelled during fetch"));
  status.resolve({ status: "completed", text: "late result" });
  await outcome;
  expect(state.submit).not.toHaveBeenCalled();
  expect(state.changes.listenerCount("catalog")).toBe(0);
});

test("already aborted wait does not fetch or retain listeners", async () => {
  const state = fixture();
  state.controller.abort(new Error("already cancelled"));
  await expect(state.run()).rejects.toThrow("already cancelled");
  expect(state.assignment).not.toHaveBeenCalled();
  expect(state.changes.listenerCount("catalog")).toBe(0);
});
