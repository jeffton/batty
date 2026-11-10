import { expect, test, vi } from "vite-plus/test";
import { createNodeRpcHandler } from "./node-rpc";
import type { RemoteWorkers } from "./remote-workers";
import type { RemoteConnectionCredentials } from "./remote-access";

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
