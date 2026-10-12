// @vitest-environment node
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { expect, test, vi } from "vite-plus/test";
import { streamSession } from "./session-sse";
import { OrchestrationDoc } from "./orchestration-state";
import type { Runtime } from "./runtime";
import type { TranscriptImages } from "./transcript-images";

type Publication = Parameters<Parameters<Runtime["harness"]["subscribeCommits"]>[0]>[0];

test("worker SSE refreshes stop availability for parent-owned delivery completion and resume", async () => {
  const socket = Object.assign(new EventEmitter(), {
    write: vi.fn((_packet: string) => true),
    destroyed: false,
    writableEnded: false,
    writableNeedDrain: false,
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
    state,
    nextRevision: () => 2,
    harness: {
      subscribeCommits: (listener: typeof publish) => {
        publish = listener;
        return () => {};
      },
    },
    memory: { status: () => ({ pending: 0 }) },
  } as unknown as Runtime;
  const close = streamSession(
    socket as unknown as ServerResponse,
    runtime,
    2 as never,
    { state: async (value: unknown) => value } as TranscriptImages,
    undefined,
    vi.fn(),
  );
  try {
    await vi.waitFor(() => expect(socket.write).toHaveBeenCalledOnce());
    expect(JSON.parse(socket.write.mock.calls[0]![0]!.split("data: ")[1]!)).toMatchObject({
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
    expect(state.mock.calls[1]).toEqual(["2", undefined, false, undefined]);
    expect(
      socket.write.mock.calls.some(([packet]) => packet.includes('"canStopSubagent":false')),
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
      socket.write.mock.calls.some(
        ([packet]) =>
          packet.includes('"type":"state"') && packet.includes('"canStopSubagent":true'),
      ),
    ).toBe(true);
  } finally {
    close();
  }
});
