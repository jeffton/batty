import { expect, test, vi } from "vite-plus/test";
import { createNodeRpcHandler } from "./node-rpc";
import type { RemoteWorkers } from "./remote-workers";
import type { RemoteConnectionCredentials } from "./remote-access";
import type { Runtime } from "./runtime";

type Publication = Parameters<Parameters<Runtime["harness"]["observeCommits"]>[0]["advance"]>[0];

test("catalog bookkeeping does not rescan history; lifecycle and report wakeups remain intact", async () => {
  const connection = {
    id: "peer",
    instanceId: "peer-instance",
    localGrantId: "grant",
  } as RemoteConnectionCredentials;
  let publish!: (publication: Publication) => void;
  const detach = vi.fn();
  const worker = { id: 2, workspaceId: "work", active: "task-1", startedAtMs: 1 };
  const snapshot = vi.fn(async () => ({ mainId: 1, workers: { "2": worker } }));
  const summaries = Array.from({ length: 5001 }, (_, index) => ({
    sessionId: String(index + 2),
    workspaceId: "work",
    status: index === 0 ? "running" : "completed",
  }));
  const queryPage = async ({ cursor }: { cursor?: string }) => {
    const offset = Number(cursor ?? 0);
    return {
      output: [
        {
          text: JSON.stringify({
            workers: summaries.slice(offset, offset + 100),
            ...(offset + 100 < summaries.length ? { nextCursor: String(offset + 100) } : {}),
          }),
        },
      ],
    };
  };
  const queryWorkers = vi.fn(queryPage);
  const remotes = {
    access: {
      pairedConnection: () => connection,
      listGrants: () => [{ id: "grant" }],
    },
    runtime: {
      orchestration: { queryWorkers },
      harness: {
        snapshot,
        observeCommits(observer: { advance: typeof publish }) {
          publish = observer.advance;
          return { detach };
        },
      },
    },
  } as unknown as RemoteWorkers;
  const controller = new AbortController();
  const result = await createNodeRpcHandler(remotes, connection)(
    "node.catalog.watch",
    {},
    { signal: controller.signal },
  );
  const reader = result.events!.getReader();
  const changed = (changes: unknown[]) => publish({ changes } as unknown as Publication);
  const orchestration = () =>
    changed([{ type: "document", record: { kind: "batty.orchestration" } }]);
  try {
    expect((await reader.read()).value).toEqual({ workers: summaries });
    expect(queryWorkers).toHaveBeenCalledTimes(51);
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Separate commits, not just same-tick coalescing. Previously each one
    // caused another 51-page scan and identical 5,001-worker snapshot.
    for (let index = 0; index < 3; index++) {
      orchestration();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(queryWorkers).toHaveBeenCalledTimes(51);

    worker.active = "task-2";
    orchestration();
    await reader.read();
    expect(queryWorkers).toHaveBeenCalledTimes(102);

    // Explicit reports can have an unchanged summary but wake a pending join.
    changed([{ type: "document", record: { kind: "batty.worker" } }]);
    await reader.read();
    expect(queryWorkers).toHaveBeenCalledTimes(153);

    summaries[0]!.status = "completed";
    changed([{ type: "task", value: { kind: "batty.delivery", state: { status: "terminal" } } }]);
    expect((await reader.read()).value).toEqual({ workers: summaries });
    expect(queryWorkers).toHaveBeenCalledTimes(204);

    const blocked = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    queryWorkers.mockImplementationOnce(async (input) => {
      entered.resolve();
      await blocked.promise;
      return queryPage(input);
    });
    worker.active = "task-3";
    orchestration();
    await entered.promise;
    // A report arrives while the first page is still being read. Its forced
    // wakeup must survive the in-flight registry refresh, even without a diff.
    changed([{ type: "document", record: { kind: "batty.worker" } }]);
    blocked.resolve();
    await reader.read();
    await reader.read();
    expect(queryWorkers).toHaveBeenCalledTimes(306);
  } finally {
    controller.abort();
    await reader.cancel();
  }
  expect(detach).toHaveBeenCalledOnce();
});

test.each([false, true])(
  "session watch handles grant removal during projection (transport aborted: %s)",
  async (abortTransport) => {
    let live = true;
    const projection = Promise.withResolvers<unknown>();
    const entered = Promise.withResolvers<void>();
    const detached = vi.fn();
    const connection = {
      id: "peer",
      instanceId: "peer-instance",
      localGrantId: "grant",
    } as RemoteConnectionCredentials;
    const signal = new AbortController();
    const remotes = {
      access: {
        pairedConnection: () => (live ? connection : undefined),
        listGrants: () => (live ? [{ id: "grant" }] : []),
      },
      runtime: {
        conversation: async () => ({ id: 2 }),
        orchestration: { metadata: async () => ({ isSubagent: true }) },
        main: { id: 1 },
        memory: { status: () => ({}) },
        harness: {
          observeCommits: () => ({ detach: detached }),
          observeConversation: async () => ({ value: { entries: [] }, detach: detached }),
        },
        state: async () => {
          entered.resolve();
          return projection.promise;
        },
        streamId: "stream",
      },
    } as unknown as RemoteWorkers;
    const result = await createNodeRpcHandler(remotes, connection)(
      "node.session.watch",
      { sessionId: "2" },
      { signal: signal.signal },
    );
    const reader = result.events!.getReader();
    // Attach the rejection handler before revocation can fail the stream.
    const read = reader.read().then(
      (value) => value,
      (error: unknown) => error,
    );
    await entered.promise;
    live = false;
    if (abortTransport) signal.abort();
    projection.resolve({ messages: [], historyCursor: "0", revision: 1 });
    if (abortTransport) expect(await read).toEqual({ done: true, value: undefined });
    else expect(await read).toMatchObject({ code: "UNAUTHORIZED" });
    // A second authorization failure from the error-event write used to escape
    // the detached projection promise as an unhandled rejection.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(detached).toHaveBeenCalledTimes(2);
    reader.releaseLock();
  },
);
