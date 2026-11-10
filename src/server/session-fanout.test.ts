// @vitest-environment node
import { EventEmitter } from "node:events";
import { expect, test, vi } from "vite-plus/test";
import { createSessionOperations } from "./session-api";
import type { Runtime } from "./runtime";
import type { TranscriptImages } from "./transcript-images";

// Each remote transcript owns a subscription, but unrelated token updates must
// not rebuild and transmit that transcript's projection.
test("five watched remote workers project only the worker whose event arrived", async () => {
  const changes = new EventEmitter();
  const state = vi.fn(async (id: string) => ({
    id,
    revision: 1,
    messages: [],
    historyCursor: "10",
    activeTools: [],
  }));
  const runtime = {
    config: {},
    main: { id: 1 },
    streamId: "local",
    nextRevision: () => 2,
    state,
    remotes: { changes, state: (id: string) => ({ id, historyCursor: "10" }) },
  } as unknown as Runtime;
  const operations = createSessionOperations(runtime, {
    transcriptImages: { state: async (value) => value } as TranscriptImages,
  });
  const subscriptions = await Promise.all(
    Array.from({ length: 5 }, async (_, index) => {
      const controller = new AbortController();
      const reply = await operations.get("session.watch")!(
        { sessionId: `remote:peer:${index + 1}` },
        { signal: controller.signal },
      );
      const reader = reply.events!.getReader();
      await reader.read();
      return { controller, reader };
    }),
  );
  try {
    await new Promise((resolve) => setImmediate(resolve));
    state.mockClear();
    const reads = subscriptions.map(({ reader }) => reader.read());
    changes.emit("change", "remote:peer:3");
    await vi.waitFor(() => expect(state).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(state.mock.calls.map(([id]) => id)).toEqual(["remote:peer:3"]);
    subscriptions.forEach(({ controller }) => controller.abort());
    await Promise.allSettled(reads);
  } finally {
    subscriptions.forEach(({ controller }) => controller.abort());
    await Promise.all(subscriptions.map(({ reader }) => reader.cancel()));
  }
  expect(changes.listenerCount("change")).toBe(0);
});
