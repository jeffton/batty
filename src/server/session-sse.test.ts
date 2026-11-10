// @vitest-environment node
import { EventEmitter } from "node:events";
import { expect, test, vi } from "vite-plus/test";
import { observeSession } from "./session-sse";

const conversationView = { entries: [], docs: {}, conversation: { id: 1 } };
const observeConversation = async () => ({ value: conversationView, detach: vi.fn() });
import type { Runtime } from "./runtime";
import type { TranscriptImages } from "./transcript-images";

test("native catch-up waits for consumption before reading the next page and cancels its observers", async () => {
  const writes: object[] = [];
  let pending = Promise.withResolvers<void>();
  const emit = async (event: object) => {
    writes.push(event);
    await pending.promise;
  };
  const controller = new AbortController();
  const unsubscribe = vi.fn();
  const changes = new EventEmitter();
  const state = vi.fn(async (_id: string, _view: unknown, _history: boolean, after: string) => ({
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
  observeSession(
    runtime,
    1 as never,
    { state: async (value: unknown) => value } as TranscriptImages,
    "0",
    emit,
    controller.signal,
    vi.fn(),
  );
  await new Promise((resolve) => setImmediate(resolve));
  expect(state).not.toHaveBeenCalled();
  expect(writes).toEqual([{ type: "orchestration-changed", cron: true }]);
  let previous = pending;
  pending = Promise.withResolvers<void>();
  previous.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  expect(state).toHaveBeenCalledTimes(1);
  previous = pending;
  pending = Promise.withResolvers<void>();
  previous.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  expect(state).toHaveBeenCalledTimes(2);
  expect(state.mock.calls[1]![3]).toBe("120");
  controller.abort();
  pending.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  expect(state).toHaveBeenCalledTimes(2);
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(changes.listenerCount("change")).toBe(0);
});

test("orchestration changes during blocked consumption are replayed and cleaned up", async () => {
  const pending = Promise.withResolvers<void>();
  const events: object[] = [];
  const emit = vi.fn(async (event: object) => {
    events.push(event);
    if (events.length === 1) await pending.promise;
  });
  let publish!: (value: unknown) => void;
  const unsubscribe = vi.fn();
  const changes = new EventEmitter();
  const runtime = {
    streamId: "test",
    main: { id: 1 },
    state: async () => ({ revision: 1, messages: [], hasMoreRecentMessages: false }),
    nextRevision: () => 2,
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
  const controller = new AbortController();
  const close = observeSession(
    runtime,
    1 as never,
    { state: async (value: unknown) => value } as TranscriptImages,
    "0",
    emit,
    controller.signal,
    vi.fn(),
  );
  await Promise.resolve();
  expect(events).toEqual([{ type: "orchestration-changed", cron: true }]);
  publish({
    changes: [{ type: "document", conversationId: 1, record: { kind: "batty.orchestration" } }],
  });
  pending.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  expect(
    events
      .map((event) => (event as { type: string }).type)
      .filter((type) => type === "orchestration-changed" || type === "reset"),
  ).toEqual(["orchestration-changed", "reset", "orchestration-changed"]);
  controller.abort();
  close();
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(changes.listenerCount("change")).toBe(0);
});

test("remote task changes invalidate only when the task signature changes", async () => {
  const emit = vi.fn(async (event: object) => {
    return void event;
  });
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
  const close = observeSession(
    runtime,
    1 as never,
    { state: async (value: unknown) => value } as TranscriptImages,
    "0",
    emit,
    new AbortController().signal,
    vi.fn(),
  );
  await new Promise((resolve) => setImmediate(resolve));
  const initialNotifications = emit.mock.calls.filter(([payload]) =>
    JSON.stringify(payload).includes('"type":"orchestration-changed"'),
  ).length;
  changes.emit("change");
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(
    emit.mock.calls.filter(([payload]) =>
      JSON.stringify(payload).includes('"type":"orchestration-changed"'),
    ),
  ).toHaveLength(initialNotifications);
  tasks = [{ id: "remote-worker", status: "running" }];
  changes.emit("change");
  await new Promise((resolve) => setTimeout(resolve, 5));
  const notifications = emit.mock.calls
    .map(([payload]) => JSON.stringify(payload))
    .filter((payload) => payload.includes('"type":"orchestration-changed"'));
  expect(notifications.slice(initialNotifications)).toEqual([
    expect.stringContaining('"type":"orchestration-changed","cron":false'),
  ]);
  close();
});

test("deferred progress streams without a stored commit and window rollover preserves paginated catch-up", async () => {
  const emit = vi.fn(async (event: object) => {
    return void event;
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
  const close = observeSession(
    runtime,
    2 as never,
    { state: async (value: unknown) => value } as TranscriptImages,
    "0",
    emit,
    new AbortController().signal,
    onError,
  );
  try {
    await vi.waitFor(() => expect(state).toHaveBeenCalledTimes(3));
    const resets = emit.mock.calls
      .map(
        ([event]) =>
          event as { type: string; state: { messages: unknown[]; activeAssistant: unknown } },
      )
      .filter((event) => event.type === "reset");
    expect(resets.flatMap((event) => event.state.messages)).toHaveLength(250);
    expect(resets[0]!.state.activeAssistant).toEqual({ text: "newer-than-attachment" });
    const progressView = { ...initialView, docs: { "pi.live": { text: "immediate" } } };
    observer.advance(
      { kind: "value", value: progressView, ops: [], retired: false } as never,
      {} as never,
    );
    await vi.waitFor(() => expect(state).toHaveBeenCalledTimes(4));
    expect(state.mock.calls[3]).toEqual(["2", progressView, false, "250"]);
    expect(
      emit.mock.calls.some(([packet]) => JSON.stringify(packet).includes('"text":"immediate"')),
    ).toBe(true);
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
