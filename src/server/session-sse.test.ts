// @vitest-environment node
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { expect, test, vi } from "vite-plus/test";
import { streamSession, writeStreamEvent } from "./session-sse";

const conversationView = { entries: [], docs: {}, conversation: { id: 1 } };
const observeConversation = async () => ({ value: conversationView, detach: vi.fn() });
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
    harness: { observeCommits: () => ({ detach: unsubscribe }), observeConversation },
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
      observeConversation,
      observeCommits(observer: { advance(value: unknown): void }) {
        publish = observer.advance;
        return { detach: unsubscribe };
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
      observeConversation,
      observeCommits(observer: { advance(value: unknown): void }) {
        publish = observer.advance;
        return { detach: vi.fn() };
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
    harness: { observeCommits: () => ({ detach: vi.fn() }), observeConversation },
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

test("deferred progress streams without a stored commit and window rollover preserves paginated catch-up", async () => {
  const socket = Object.assign(new EventEmitter(), {
    write: vi.fn((_packet: string) => true),
    destroyed: false,
    writableEnded: false,
    writableNeedDrain: false,
  });
  type Observer = Parameters<Runtime["harness"]["observeConversation"]>[1];
  let observer!: Observer;
  const detach = vi.fn();
  const initialView = {
    ...conversationView,
    entries: [{ id: 50 }],
  };
  const state = vi.fn(
    async (
      _id: string,
      view: { docs: Record<string, unknown> },
      history: boolean,
      after: string,
    ) => {
      const cursor = Number(after ?? 0);
      return {
        revision: 1,
        messages: history
          ? Array.from({ length: Math.min(120, 250 - cursor) }, (_, n) => ({ id: cursor + n + 1 }))
          : [],
        historyCursor: history ? String(Math.min(cursor + 120, 250)) : undefined,
        hasMoreRecentMessages: history && cursor + 120 < 250,
        activeAssistant: view.docs["pi.live"],
      };
    },
  );
  const onError = vi.fn();
  const runtime = {
    streamId: "test",
    main: { id: 1 },
    state,
    nextRevision: () => 2,
    harness: {
      observeCommits: () => ({ detach: vi.fn() }),
      observeConversation: async (_id: unknown, value: Observer) => {
        observer = value;
        // An advance can precede delivery of the attachment-time observation.
        observer.advance(
          {
            kind: "value",
            value: { ...initialView, docs: { "pi.live": { text: "newer-than-attachment" } } },
            ops: [],
          } as never,
          {} as never,
        );
        return { value: initialView, detach };
      },
    },
    memory: { status: () => ({ pending: 0 }) },
  } as unknown as Runtime;
  const close = streamSession(
    socket as unknown as ServerResponse,
    runtime,
    2 as never,
    { state: async (value: unknown) => value } as TranscriptImages,
    "0",
    onError,
  );
  try {
    await vi.waitFor(() => expect(state).toHaveBeenCalledTimes(3));
    const resets = socket.write.mock.calls
      .map(([packet]) => JSON.parse(packet.slice(6)))
      .filter((event) => event.type === "reset");
    expect(resets.flatMap((event) => event.state.messages)).toHaveLength(250);
    expect(resets[0].state.activeAssistant).toEqual({ text: "newer-than-attachment" });
    const progressView = { ...initialView, docs: { "pi.live": { text: "immediate" } } };
    observer.advance(
      { kind: "value", value: progressView, ops: [], retired: false } as never,
      {} as never,
    );
    await vi.waitFor(() => expect(state).toHaveBeenCalledTimes(4));
    expect(state.mock.calls[3]).toEqual(["2", progressView, false, "250"]);
    expect(socket.write.mock.calls.some(([packet]) => packet.includes('"text":"immediate"'))).toBe(
      true,
    );
    // The watched window shrinks to 50 after rollover. Its contents are only an
    // invalidation signal; catch-up still starts from the browser's own cursor.
    observer.advance(
      {
        kind: "value",
        value: { ...progressView, before: 300, entries: [{ id: 350 }] },
        ops: [],
      } as never,
      {} as never,
    );
    await vi.waitFor(() => expect(state).toHaveBeenCalledTimes(5));
    expect(state.mock.calls[4]?.slice(2)).toEqual([true, "250"]);
    expect(onError).not.toHaveBeenCalled();
  } finally {
    close();
  }
  expect(detach).toHaveBeenCalledOnce();
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
