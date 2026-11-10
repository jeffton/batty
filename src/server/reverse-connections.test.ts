import { EventEmitter, once } from "node:events";
import { setImmediate } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { expect, test, vi } from "vite-plus/test";
import { RpcChannel } from "../shared/rpc-channel";
import { ReverseConnections } from "./reverse-connections";
import type { RemoteConnectionCredentials } from "./remote-access";
import type { RemoteWorkers } from "./remote-workers";

function peer(url: string): RemoteConnectionCredentials {
  return {
    id: "peer",
    label: "Windows",
    url,
    token: "test-token",
    instanceId: "windows-instance",
    reverseDial: true,
    localGrantId: "local-grant",
  };
}

test("superseded WebSocket identity cleanup cannot overwrite its replacement connection status", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener");
  let connection = peer(`http://127.0.0.1:${address.port}/batty/`);
  const oldIdentity = Promise.withResolvers<void>();
  const updates = vi
    .fn()
    .mockImplementationOnce(() => oldIdentity.promise)
    .mockResolvedValue(undefined);
  const connect = vi.fn();
  const handshakes: { path?: string; authorization?: string; instance?: string | string[] }[] = [];
  const channels: RpcChannel[] = [];
  server.on("connection", (socket, request) => {
    handshakes.push({
      path: request.url,
      authorization: request.headers.authorization,
      instance: request.headers["x-batty-instance-id"],
    });
    channels.push(
      new RpcChannel(socket, {
        handle: async (operation) => {
          expect(operation).toBe("node.identity");
          return { value: { instanceId: "windows-instance", grantId: "remote-grant" } };
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
  } as unknown as RemoteWorkers;
  const manager = new ReverseConnections(remotes);
  try {
    manager.start();
    await vi.waitFor(() => expect(updates).toHaveBeenCalledTimes(1));
    expect(manager.status("peer").state).toBe("connecting");
    expect(manager.hasControl("peer")).toBe(false);
    connection = { ...connection, label: "Renamed Windows" };
    manager.reconfigure();
    await vi.waitFor(() => expect(manager.status("peer").state).toBe("connected"));
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
  const connection = peer(`http://127.0.0.1:${address.port}/`);
  let granted = true;
  const channels: RpcChannel[] = [];
  server.on("connection", (socket) =>
    channels.push(
      new RpcChannel(socket, {
        handle: async () => ({
          value: { instanceId: "windows-instance", grantId: "remote-grant" },
        }),
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
  } as unknown as RemoteWorkers;
  const manager = new ReverseConnections(remotes);
  try {
    manager.start();
    await vi.waitFor(() => expect(manager.status("peer").state).toBe("connected"));
    const active = manager.channel(connection);
    granted = false;
    manager.reconfigure();
    await active.closed;
    await vi.waitFor(() => expect(manager.status("peer").state).toBe("disconnected"));
    expect(() => manager.channel(connection)).toThrow("Peer access removed");
    await expect(active.call("node.identity", {})).rejects.toMatchObject({ code: "OFFLINE" });
  } finally {
    await manager.close();
    for (const channel of channels) channel.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("an unverified mismatched peer cannot command, fetch files or unpair before identity completes", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener");
  const connection = peer(`http://127.0.0.1:${address.port}/`);
  const release = Promise.withResolvers<void>();
  const probesSent = Promise.withResolvers<void>();
  const domain = vi.fn(async () => ({ value: null }));
  const updateIdentity = vi.fn();
  const channels: RpcChannel[] = [];
  const probes: Promise<unknown>[] = [];
  server.on("connection", (socket) => {
    const channel = new RpcChannel(socket, {
      handle: async () => {
        await release.promise;
        return { value: { instanceId: "impostor", grantId: "remote-grant" } };
      },
    });
    channels.push(channel);
    for (const operation of ["node.command", "node.file", "node.unpair"])
      probes.push(channel.call(operation, {}).catch((error) => error));
    probesSent.resolve();
  });
  const remotes = {
    changes: new EventEmitter(),
    access: {
      listGrants: () => [{ id: "local-grant" }],
      listConnections: () => [connection],
      getConnection: () => connection,
      identity: () => ({ instanceId: "mac-instance" }),
      updateIdentity,
    },
    connection: () => connection,
    connect: vi.fn(),
    handleNode: domain,
  } as unknown as RemoteWorkers;
  const manager = new ReverseConnections(remotes);
  try {
    manager.start();
    await probesSent.promise;
    await setImmediate();
    expect(manager.hasControl("peer")).toBe(false);
    expect(() => manager.channel(connection)).toThrow("offline");
    expect(domain).not.toHaveBeenCalled();
    release.resolve();
    const results = await Promise.all(probes);
    expect(results).toHaveLength(3);
    expect(results.every((result) => result instanceof Error)).toBe(true);
    expect(domain).not.toHaveBeenCalled();
    expect(updateIdentity).not.toHaveBeenCalled();
    expect(manager.hasControl("peer")).toBe(false);
  } finally {
    release.resolve();
    await manager.close();
    for (const channel of channels) channel.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
