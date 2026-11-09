import { EventEmitter, once } from "node:events";
import { setImmediate } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { expect, test, vi } from "vite-plus/test";
import { SocketChannel } from "../shared/socket-channel";
import { ReverseConnections } from "./reverse-connections";
import type { RemoteConnectionCredentials } from "./remote-access";
import type { RemoteWorkers } from "./remote-workers";

test("superseded WebSocket identity cleanup cannot overwrite its replacement connection status", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener");
  let connection: RemoteConnectionCredentials = {
    id: "peer",
    label: "Windows",
    url: `http://127.0.0.1:${address.port}/batty/`,
    token: "test-token",
    instanceId: "windows-instance",
    transport: "reverse",
    reverseDial: true,
    localGrantId: "local-grant",
  };
  const oldIdentity = Promise.withResolvers<void>();
  const updates = vi
    .fn()
    .mockImplementationOnce(() => oldIdentity.promise)
    .mockResolvedValue(undefined);
  const connect = vi.fn();
  const handshakes: { path?: string; authorization?: string; instance?: string | string[] }[] = [];
  const channels: SocketChannel[] = [];
  server.on("connection", (socket, request) => {
    handshakes.push({
      path: request.url,
      authorization: request.headers.authorization,
      instance: request.headers["x-batty-instance-id"],
    });
    channels.push(
      new SocketChannel(socket, {
        handle: async (path) => {
          expect(path).toBe("identity");
          return Response.json({ instanceId: "windows-instance", grantId: "remote-grant" });
        },
      }),
    );
  });
  const remotes = {
    changes: new EventEmitter(),
    access: {
      listGrants: () => [{ id: "local-grant" }],
      listConnections: () => [connection],
      getConnection: () => connection,
      identity: () => ({ instanceId: "mac-instance" }),
      updateIdentity: updates,
    },
    connection: () => connection,
    connect,
    requestNode: (peer: RemoteConnectionCredentials, route: string, init?: RequestInit) =>
      manager
        .channel(peer)
        .request(route, new Request(new URL(`api/node/${route}`, peer.url), init)),
  } as unknown as RemoteWorkers;
  const manager = new ReverseConnections(remotes);
  try {
    manager.start("http://127.0.0.1:1234/");
    await vi.waitFor(() => expect(updates).toHaveBeenCalledTimes(1));
    expect(manager.status("peer").state).toBe("connecting");
    connection = { ...connection, label: "Renamed Windows" };
    manager.reconfigure();
    await vi.waitFor(() => expect(manager.status("peer").state).toBe("connected"));
    // The old identity operation can fail after the replacement channel is ready.
    oldIdentity.reject(new Error("Delayed old identity failure"));
    await setImmediate();
    expect(manager.status("peer")).toEqual({ state: "connected" });
    expect(manager.hasControl("peer")).toBe(true);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(handshakes).toEqual(
      Array.from({ length: 2 }, () => ({
        path: "/batty/api/node/socket",
        authorization: "Bearer test-token",
        instance: "mac-instance",
      })),
    );
  } finally {
    oldIdentity.resolve();
    await manager.close();
    for (const channel of channels) channel.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("revoking the local grant closes the actual socket and blocks further requests", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener");
  const connection: RemoteConnectionCredentials = {
    id: "peer",
    label: "Windows",
    url: `http://127.0.0.1:${address.port}/`,
    token: "test-token",
    instanceId: "windows-instance",
    transport: "reverse",
    reverseDial: true,
    localGrantId: "local-grant",
  };
  let granted = true;
  const channels: SocketChannel[] = [];
  server.on("connection", (socket) =>
    channels.push(
      new SocketChannel(socket, {
        handle: async () =>
          Response.json({ instanceId: "windows-instance", grantId: "remote-grant" }),
      }),
    ),
  );
  const remotes = {
    changes: new EventEmitter(),
    access: {
      listGrants: () => (granted ? [{ id: "local-grant" }] : []),
      listConnections: () => [connection],
      getConnection: () => connection,
      identity: () => ({ instanceId: "mac-instance" }),
      updateIdentity: async () => {},
    },
    connection: () => connection,
    connect: vi.fn(),
    requestNode: (peer: RemoteConnectionCredentials, route: string, init?: RequestInit) =>
      manager
        .channel(peer)
        .request(route, new Request(new URL(`api/node/${route}`, peer.url), init)),
  } as unknown as RemoteWorkers;
  const manager = new ReverseConnections(remotes);
  try {
    manager.start("http://127.0.0.1:1234/");
    await vi.waitFor(() => expect(manager.status("peer").state).toBe("connected"));
    const active = manager.channel(connection);
    granted = false;
    manager.reconfigure();
    await active.closed;
    await vi.waitFor(() => expect(manager.status("peer").state).toBe("disconnected"));
    expect(() => manager.channel(connection)).toThrow("Peer access removed");
    await expect(active.request("identity", new Request("https://peer.test/"))).rejects.toThrow(
      "offline",
    );
  } finally {
    await manager.close();
    for (const channel of channels) channel.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
