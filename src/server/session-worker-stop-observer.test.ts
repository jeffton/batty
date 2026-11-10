// @vitest-environment node
import { expect, test, vi } from "vite-plus/test";
import { observeSession } from "./session-observer";
import { OrchestrationDoc } from "./orchestration-state";
import type { Runtime } from "./runtime";
import type { TranscriptImages } from "./transcript-images";

type Publication = Parameters<Parameters<Runtime["harness"]["observeCommits"]>[0]["advance"]>[0];
const conversationView = { entries: [], docs: {}, conversation: { id: 2 } };

test("worker events refresh stop availability for parent-owned delivery completion and resume", async () => {
  const emit = vi.fn(async (event: object) => {
    return void event;
  });
  let canStopSubagent = true;
  let publish!: (publication: Publication) => void;
  const state = vi.fn(
    async (_id: string, _view: undefined, _history: boolean, _after?: string) => ({
      isStreaming: false,
      canStopSubagent,
      messages: [],
      revision: 1,
    }),
  );
  const runtime = {
    streamId: "test",
    main: { id: 1 },
    state,
    nextRevision: () => 2,
    harness: {
      observeConversation: async () => ({ value: conversationView, detach() {} }),
      observeCommits: (observer: { advance: typeof publish }) => {
        publish = observer.advance;
        return { detach() {} };
      },
    },
    memory: { status: () => ({ pending: 0 }) },
  } as unknown as Runtime;
  const close = observeSession(
    runtime,
    2 as never,
    { state: async (value: unknown) => value } as TranscriptImages,
    undefined,
    emit,
    new AbortController().signal,
    vi.fn(),
  );
  try {
    await vi.waitFor(() => expect(emit).toHaveBeenCalledOnce());
    expect(emit.mock.calls[0]![0]!).toMatchObject({
      type: "reset",
      state: { isStreaming: false, canStopSubagent: true },
    });
    canStopSubagent = false;
    publish({
      changes: [
        {
          type: "task",
          value: {
            kind: "batty.delivery",
            conversationId: 1,
            input: { workerId: "2" },
            state: { status: "terminal" },
          },
        },
      ],
    } as unknown as Publication);
    await vi.waitFor(() => expect(state).toHaveBeenCalledTimes(2));
    expect(state.mock.calls[1]).toEqual(["2", conversationView, false, undefined]);
    expect(
      emit.mock.calls.some(([packet]) =>
        JSON.stringify(packet).includes('"canStopSubagent":false'),
      ),
    ).toBe(true);
    canStopSubagent = true;
    publish({
      changes: [
        {
          type: "document",
          record: { kind: OrchestrationDoc.definition.kind },
        },
      ],
    } as unknown as Publication);
    await vi.waitFor(() => expect(state).toHaveBeenCalledTimes(3));
    expect(
      emit.mock.calls.some(
        ([packet]) =>
          JSON.stringify(packet).includes('"type":"state"') &&
          JSON.stringify(packet).includes('"canStopSubagent":true'),
      ),
    ).toBe(true);
  } finally {
    close();
  }
});
