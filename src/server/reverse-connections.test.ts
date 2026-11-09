import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import { expect, test, vi } from "vite-plus/test";
import { ReverseConnections } from "./reverse-connections";
import type { RemoteConnectionCredentials } from "./remote-access";
import type { RemoteWorkers } from "./remote-workers";

test("superseded dial cleanup cannot overwrite its replacement connection status", async () => {
  let connection: RemoteConnectionCredentials = {
    id: "peer",
    label: "Windows",
    url: "https://receiver.test/",
    token: "test-token",
    instanceId: "windows-instance",
    transport: "reverse",
    reverseDial: true,
    localGrantId: "local-grant",
  };
  const oldHandshake = Promise.withResolvers<Response>();
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  const currentStream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
  });
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementationOnce(() => oldHandshake.promise)
    .mockImplementationOnce(async (_input, init) => {
      init?.signal?.addEventListener("abort", () => streamController.error(init.signal?.reason));
      return new Response(currentStream, {
        headers: { "x-batty-instance-id": "windows-instance" },
      });
    });
  const remotes = {
    changes: new EventEmitter(),
    access: {
      listGrants: () => [],
      listConnections: () => [connection],
      getConnection: () => connection,
      identity: () => ({ instanceId: "mac-instance" }),
    },
    connection: () => connection,
  } as unknown as RemoteWorkers;
  const manager = new ReverseConnections(remotes);
  try {
    manager.start("http://127.0.0.1:1234/");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    connection = { ...connection, label: "Renamed Windows" };
    manager.reconfigure();
    await vi.waitFor(() => expect(manager.status("peer").state).toBe("connected"));
    // A transport may deliver its final failure after AbortController has fired.
    oldHandshake.reject(new Error("Delayed old connection failure"));
    await setImmediate();
    expect(manager.status("peer")).toEqual({ state: "connected" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  } finally {
    await manager.close();
    fetchMock.mockRestore();
  }
});
