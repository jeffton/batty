import WebSocket from "ws";
import { RPC_MAX_MESSAGE_BYTES, RpcChannel, RpcError } from "../shared/rpc";
import type { NodeOutputs } from "../shared/node-api";
import type { RemoteConnectionCredentials } from "./remote-access";
import type { RemoteWorkers } from "./remote-workers";

export type ReverseStatus = {
  state: "connected" | "connecting" | "disconnected" | "error";
  error?: string;
};
type Link = { channel: RpcChannel; configuration: string; ready: boolean };
type Dial = { controller: AbortController; configuration: string };

/** Both directions use the same duplex channel as browsers. Only the dialer
 * needs a reachable URL. Reconnect never replays a command or owns job lifetime.
 */
export class ReverseConnections {
  private started = false;
  private stopped = false;
  private readonly links = new Map<string, Link>();
  private readonly outgoing = new Map<string, Dial>();
  private readonly statuses = new Map<string, ReverseStatus>();
  private readonly loops = new Set<Promise<void>>();

  constructor(private readonly remotes: RemoteWorkers) {}
  status(id: string): ReverseStatus {
    return this.statuses.get(id) ?? { state: "disconnected" };
  }
  hasControl(id: string): boolean {
    return (
      !!this.remotes.access.getConnection(id)?.localGrantId && this.links.get(id)?.ready === true
    );
  }

  async notifyRemoval(connection: RemoteConnectionCredentials): Promise<void> {
    await this.remotes.requestNode(
      connection,
      "node.unpair",
      {},
      { signal: AbortSignal.timeout(5000) },
    );
  }

  start() {
    this.started = true;
    this.reconfigure();
  }

  reconfigure() {
    for (const [id, entry] of this.links) {
      const connection = this.remotes.access.getConnection(id);
      if (
        !connection ||
        !this.validGrant(connection) ||
        JSON.stringify(connection) !== entry.configuration
      )
        entry.channel.close();
    }
    for (const [id, entry] of this.outgoing) {
      const connection = this.remotes.access.getConnection(id);
      if (
        !connection?.reverseDial ||
        !this.validGrant(connection) ||
        JSON.stringify(connection) !== entry.configuration
      ) {
        entry.controller.abort();
        this.outgoing.delete(id);
      }
    }
    if (!this.started || this.stopped) return;
    for (const item of this.remotes.access.listConnections()) {
      const connection = this.remotes.connection(item.id);
      if (
        !connection.reverseDial ||
        !this.validGrant(connection) ||
        this.outgoing.has(connection.id)
      )
        continue;
      const dial = { controller: new AbortController(), configuration: JSON.stringify(connection) };
      this.outgoing.set(connection.id, dial);
      const loop = this.dial(connection, dial).finally(() => {
        if (this.outgoing.get(connection.id) === dial) this.outgoing.delete(connection.id);
      });
      this.loops.add(loop);
      void loop.finally(() => this.loops.delete(loop));
    }
  }

  private validGrant(connection: RemoteConnectionCredentials) {
    return (
      !!connection.localGrantId &&
      this.remotes.access.listGrants().some((grant) => grant.id === connection.localGrantId)
    );
  }

  connectionFor(grantId: string, instanceId: string): RemoteConnectionCredentials {
    const connection = this.remotes.access.pairedConnection(grantId);
    if (!connection || connection.transport !== "reverse" || connection.instanceId !== instanceId)
      throw Object.assign(new Error("Socket peer identity mismatch"), { statusCode: 403 });
    return connection;
  }

  accept(connection: RemoteConnectionCredentials, socket: WebSocket): RpcChannel {
    if (!this.started) throw new Error("Node listener is not ready");
    this.links.get(connection.id)?.channel.close();
    const verified = Promise.withResolvers<void>();
    // A disconnect/mismatch may happen without a pending inbound operation.
    void verified.promise.catch(() => {});
    const channel = new RpcChannel(socket, {
      handle: async (operation, input, call) => {
        if (operation !== "node.identity") await verified.promise;
        call.signal.throwIfAborted();
        return this.remotes.handleNode(connection, operation, input, call);
      },
    });
    const link = { channel, configuration: JSON.stringify(connection), ready: false };
    this.links.set(connection.id, link);
    this.setStatus(connection.id, { state: "connecting" });
    void channel.closed.then(() => {
      verified.reject(new RpcError("OFFLINE", "Peer identity handshake disconnected"));
      if (this.links.get(connection.id) !== link) return;
      this.links.delete(connection.id);
      this.setStatus(connection.id, { state: "disconnected" });
    });
    void channel
      .call<NodeOutputs["node.identity"], never>(
        "node.identity",
        {},
        { signal: AbortSignal.timeout(30_000) },
      )
      .then(async ({ value: identity }) => {
        if (identity.instanceId !== connection.instanceId)
          throw new Error("Socket peer identity mismatch");
        if (this.links.get(connection.id) !== link) return;
        await this.remotes.access.updateIdentity(connection.id, identity);
        if (this.links.get(connection.id) !== link) return;
        link.configuration = JSON.stringify(this.remotes.connection(connection.id));
        link.ready = true;
        verified.resolve();
        this.setStatus(connection.id, { state: "connected" });
        this.remotes.connect(connection.id);
      })
      .catch((error: unknown) => {
        verified.reject(error);
        if (this.links.get(connection.id) !== link) return;
        channel.close();
        this.setStatus(connection.id, { state: "error", error: String(error) });
      });
    return channel;
  }

  channel(connection: RemoteConnectionCredentials): RpcChannel {
    if (!this.validGrant(connection)) throw new RpcError("FORBIDDEN", "Peer access removed");
    const link = this.links.get(connection.id);
    if (!link?.ready) throw new RpcError("OFFLINE", `Remote ${connection.id}: socket is offline`);
    return link.channel;
  }

  private setStatus(id: string, status: ReverseStatus) {
    const previous = this.status(id).state;
    this.statuses.set(id, status);
    if (previous !== status.state) this.remotes.changes.emit("catalog", id);
  }

  private async dial(connection: RemoteConnectionCredentials, dial: Dial) {
    const signal = dial.controller.signal;
    let attempts = 0;
    while (!signal.aborted && !this.stopped) {
      let socket: WebSocket | undefined;
      let abort: (() => void) | undefined;
      try {
        this.setStatus(connection.id, { state: "connecting" });
        const url = new URL("api/node/socket", connection.url);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        socket = new WebSocket(url, {
          headers: {
            authorization: `Bearer ${connection.token}`,
            "x-batty-instance-id": this.remotes.access.identity().instanceId,
          },
          handshakeTimeout: 30_000,
          maxPayload: RPC_MAX_MESSAGE_BYTES,
          perMessageDeflate: false,
          followRedirects: false,
        });
        // A pending handshake also needs an error listener before it can abort.
        socket.on("error", () => {});
        abort = () => socket!.terminate();
        signal.addEventListener("abort", abort, { once: true });
        const channel = await new Promise<RpcChannel>((resolve, reject) => {
          socket!.once("open", () => {
            // ws can emit messages immediately after open in the same read.
            // Install channel listeners before returning to its frame decoder.
            try {
              resolve(this.accept(connection, socket!));
            } catch (error) {
              reject(error);
            }
          });
          socket!.once("error", reject);
          socket!.once("close", () => reject(new Error("Socket handshake closed")));
          socket!.once("unexpected-response", (_request, response) => {
            response.resume();
            socket!.terminate();
            reject(
              new RpcError(
                response.statusCode === 401
                  ? "UNAUTHORIZED"
                  : response.statusCode === 403
                    ? "FORBIDDEN"
                    : "OFFLINE",
                `Peer socket HTTP ${response.statusCode}`,
              ),
            );
          });
        });
        attempts = 0;
        await channel.closed;
      } catch (error) {
        if (
          !signal.aborted &&
          this.outgoing.get(connection.id) === dial &&
          error instanceof RpcError &&
          ["UNAUTHORIZED", "FORBIDDEN"].includes(error.code)
        ) {
          await this.remotes.access.removeConnection(connection.id);
          this.remotes.disconnect(connection.id);
        }
        if (!signal.aborted)
          this.setStatus(connection.id, { state: "error", error: String(error) });
      } finally {
        if (abort) signal.removeEventListener("abort", abort);
        socket?.terminate();
      }
      if (signal.aborted || !this.remotes.access.getConnection(connection.id)) break;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(
          done,
          Math.min(30_000, 500 * 2 ** Math.min(attempts++, 6)) * (0.8 + Math.random() * 0.4),
        );
        signal.addEventListener("abort", done, { once: true });
      });
    }
    if (!this.links.has(connection.id)) this.setStatus(connection.id, { state: "disconnected" });
  }

  async close() {
    this.stopped = true;
    for (const link of this.links.values()) link.channel.close();
    for (const dial of this.outgoing.values()) dial.controller.abort();
    await Promise.allSettled(this.loops);
  }
}
