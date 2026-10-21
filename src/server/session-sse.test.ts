// @vitest-environment node
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { expect, test, vi } from "vite-plus/test";
import { streamSession, writeStreamEvent } from "./session-sse";
import type { Runtime } from "./runtime";
import type { TranscriptImages } from "./transcript-images";

test("SSE catch-up waits for socket drain before reading the next page and cancels on disconnect", async () => {
  const socket = new EventEmitter() as EventEmitter & {
    write: ReturnType<typeof vi.fn>;
    destroyed: boolean;
    writableEnded: boolean;
    writableNeedDrain: boolean;
  };
  socket.write = vi.fn(() => false);
  socket.destroyed = false;
  socket.writableEnded = false;
  socket.writableNeedDrain = true;
  const unsubscribe = vi.fn();
  const changes = new EventEmitter();
  const state = vi.fn(async (_id: string, _view: undefined, _history: boolean, after: string) => ({
    historyAfter: after,
    historyCursor: String(Number(after ?? 0) + 120),
    hasMoreRecentMessages: true,
    messages: [],
    revision: 1,
  }));
  const runtime = {
    streamId: "test",
    main: { id: 1 },
    state,
    remotes: { tasks: () => [], changes },
    harness: { subscribeCommits: () => unsubscribe },
    memory: { status: () => ({ pending: 0 }) },
  } as unknown as Runtime;
  const images = { state: async (value: unknown) => value } as TranscriptImages;
  const close = streamSession(
    socket as unknown as ServerResponse,
    runtime,
    1 as never,
    images,
    "0",
    vi.fn(),
  );
  await new Promise((resolve) => setImmediate(resolve));
  expect(state).not.toHaveBeenCalled();
  expect(socket.write).toHaveBeenCalledTimes(1);
  expect(socket.write.mock.calls[0]![0]).toContain('"type":"orchestration-changed"');
  socket.emit("drain");
  await new Promise((resolve) => setImmediate(resolve));
  expect(state).toHaveBeenCalledTimes(1);
  expect(socket.write).toHaveBeenCalledTimes(2);
  socket.emit("drain");
  await new Promise((resolve) => setImmediate(resolve));
  expect(state).toHaveBeenCalledTimes(2);
  expect(state.mock.calls[1]![3]).toBe("120");
  socket.destroyed = true;
  socket.emit("close");
  await new Promise((resolve) => setImmediate(resolve));
  expect(state).toHaveBeenCalledTimes(2);
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(changes.listenerCount("change")).toBe(0);
  expect(socket.listenerCount("drain")).toBe(0);
  close();
});

test("local orchestration commits emit a cron invalidation and disconnect unsubscribes", async () => {
  const socket = new EventEmitter() as EventEmitter & {
    write: ReturnType<typeof vi.fn>;
    destroyed: boolean;
    writableEnded: boolean;
    writableNeedDrain: boolean;
  };
  socket.write = vi.fn(() => true);
  socket.destroyed = false;
  socket.writableEnded = false;
  socket.writableNeedDrain = false;
  const changes = new EventEmitter();
  let publish!: (value: unknown) => void;
  const unsubscribe = vi.fn();
  const state = vi.fn(async () => ({ revision: 1, messages: [], hasMoreRecentMessages: false }));
  const runtime = {
    streamId: "test",
    main: { id: 1 },
    state,
    remotes: { tasks: () => [], changes },
    harness: {
      subscribeCommits(callback: (value: unknown) => void) {
        publish = callback;
        return unsubscribe;
      },
    },
    memory: { status: () => ({ pending: 0 }) },
  } as unknown as Runtime;
  const close = streamSession(
    socket as unknown as ServerResponse,
    runtime,
    1 as never,
    { state: async (value: unknown) => value } as TranscriptImages,
    "0",
    vi.fn(),
  );
  await new Promise((resolve) => setImmediate(resolve));
  publish({
    changes: [
      {
        type: "document",
        conversationId: 1,
        record: { kind: "batty.orchestration" },
      },
    ],
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(socket.write.mock.calls.map(([payload]) => payload).join("")).toContain(
    '"type":"orchestration-changed","cron":true',
  );
  expect(changes.listenerCount("change")).toBe(1);
  socket.emit("close");
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(changes.listenerCount("change")).toBe(0);
  close();
});

test("does not lose orchestration invalidations committed during initial backpressure", async () => {
  const socket = new EventEmitter() as EventEmitter & {
    write: ReturnType<typeof vi.fn>;
    destroyed: boolean;
    writableEnded: boolean;
    writableNeedDrain: boolean;
  };
  socket.write = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
  socket.destroyed = false;
  socket.writableEnded = false;
  socket.writableNeedDrain = true;
  let publish!: (value: unknown) => void;
  const runtime = {
    streamId: "test",
    main: { id: 1 },
    state: async () => ({ revision: 1, messages: [], hasMoreRecentMessages: false }),
    remotes: { tasks: () => [], changes: new EventEmitter() },
    harness: {
      subscribeCommits(callback: (value: unknown) => void) {
        publish = callback;
        return vi.fn();
      },
    },
    memory: { status: () => ({ pending: 0 }) },
  } as unknown as Runtime;
  const close = streamSession(
    socket as unknown as ServerResponse,
    runtime,
    1 as never,
    { state: async (value: unknown) => value } as TranscriptImages,
    "0",
    vi.fn(),
  );
  await Promise.resolve();
  expect(socket.write).toHaveBeenCalledTimes(1);
  expect(socket.write.mock.calls[0]![0]).toContain('"type":"orchestration-changed"');
  publish({
    changes: [{ type: "document", conversationId: 1, record: { kind: "batty.orchestration" } }],
  });
  socket.emit("drain");
  await new Promise((resolve) => setImmediate(resolve));
  const payloads = socket.write.mock.calls.map(([payload]) => String(payload)).join("");
  expect(payloads.match(/"type":"orchestration-changed"/g)).toHaveLength(2);
  expect(payloads.indexOf('"type":"reset"')).toBeGreaterThan(
    payloads.indexOf('"type":"orchestration-changed"'),
  );
  expect(payloads.lastIndexOf('"type":"orchestration-changed"')).toBeGreaterThan(
    payloads.indexOf('"type":"reset"'),
  );
  close();
});

test("remote task changes invalidate only when the task signature changes", async () => {
  const socket = new EventEmitter() as EventEmitter & {
    write: ReturnType<typeof vi.fn>;
    destroyed: boolean;
    writableEnded: boolean;
    writableNeedDrain: boolean;
  };
  socket.write = vi.fn(() => true);
  socket.destroyed = false;
  socket.writableEnded = false;
  socket.writableNeedDrain = false;
  const changes = new EventEmitter();
  let tasks: unknown[] = [];
  const runtime = {
    streamId: "test",
    main: { id: 1 },
    state: async () => ({ revision: 1, messages: [], hasMoreRecentMessages: false }),
    remotes: { tasks: () => tasks, changes },
    harness: { subscribeCommits: () => vi.fn() },
    memory: { status: () => ({ pending: 0 }) },
  } as unknown as Runtime;
  const close = streamSession(
    socket as unknown as ServerResponse,
    runtime,
    1 as never,
    { state: async (value: unknown) => value } as TranscriptImages,
    "0",
    vi.fn(),
  );
  await new Promise((resolve) => setImmediate(resolve));
  const initialNotifications = socket.write.mock.calls.filter(([payload]) =>
    String(payload).includes('"type":"orchestration-changed"'),
  ).length;
  changes.emit("change");
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(
    socket.write.mock.calls.filter(([payload]) =>
      String(payload).includes('"type":"orchestration-changed"'),
    ),
  ).toHaveLength(initialNotifications);
  tasks = [{ id: "remote-worker", status: "running" }];
  changes.emit("change");
  await new Promise((resolve) => setTimeout(resolve, 5));
  const notifications = socket.write.mock.calls
    .map(([payload]) => String(payload))
    .filter((payload) => payload.includes('"type":"orchestration-changed"'));
  expect(notifications.slice(initialNotifications)).toEqual([
    expect.stringContaining('"type":"orchestration-changed","cron":false'),
  ]);
  close();
});

test("drain and close listeners are released after successful backpressure wait", async () => {
  const socket = new EventEmitter() as EventEmitter & {
    write: () => boolean;
    destroyed: boolean;
    writableEnded: boolean;
  };
  socket.write = () => false;
  socket.destroyed = false;
  socket.writableEnded = false;
  let completed = false;
  const write = writeStreamEvent(socket as unknown as ServerResponse, "event").then(() => {
    completed = true;
  });
  await Promise.resolve();
  expect(completed).toBe(false);
  socket.emit("drain");
  await write;
  expect(completed).toBe(true);
  expect(socket.listenerCount("drain")).toBe(0);
  expect(socket.listenerCount("close")).toBe(0);
});
