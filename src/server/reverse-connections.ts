import type { RemoteConnectionCredentials } from "./remote-access";
import type { RemoteWorkers } from "./remote-workers";
import { NodeHttpError, nodeRequest, readNodeEvents } from "./remote-workers";
import {
  ReverseChannel,
  isNodeRoute,
  responseMetadata,
  type ReverseEvent,
} from "./reverse-transport";

export type ReverseStatus = {
  state: "connected" | "connecting" | "disconnected" | "error";
  error?: string;
};
type Incoming = {
  channel: ReverseChannel;
  close: () => void;
  configuration: string;
  acknowledged: number;
};
type Dial = { controller: AbortController; configuration: string };

/** Installation-local volatile channels; task lifetime remains entirely in RemoteWorkers. */
export class ReverseConnections {
  private localUrl?: string;
  private stopped = false;
  private grants = "";
  private readonly incoming = new Map<string, Incoming>();
  private readonly outgoing = new Map<string, Dial>();
  private readonly statuses = new Map<string, ReverseStatus>();
  private readonly denied = new Map<string, NodeHttpError>();
  private readonly loops = new Set<Promise<void>>();

  constructor(private readonly remotes: RemoteWorkers) {}

  status(id: string): ReverseStatus {
    return this.statuses.get(id) ?? { state: "disconnected" };
  }

  start(localUrl: string) {
    const url = new URL(localUrl);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.protocol !== "http:")
      throw new Error("Reverse bridge requires a local HTTP listener");
    this.localUrl = url.href;
    this.reconfigure();
  }

  reconfigure() {
    const grants = JSON.stringify(this.remotes.access.listGrants());
    const grantsChanged = this.grants !== grants;
    this.grants = grants;
    for (const [id, entry] of this.incoming) {
      const connection = this.remotes.access.getConnection(id);
      if (grantsChanged || !connection || JSON.stringify(connection) !== entry.configuration)
        entry.close();
    }
    for (const [id, entry] of this.outgoing) {
      const connection = this.remotes.access.getConnection(id);
      if (
        grantsChanged ||
        !connection?.reverseDial ||
        JSON.stringify(connection) !== entry.configuration
      ) {
        entry.controller.abort();
        this.outgoing.delete(id);
        this.statuses.set(id, { state: "disconnected" });
      }
    }
    if (!this.localUrl || this.stopped) return;
    for (const item of this.remotes.access.listConnections()) {
      const connection = this.remotes.connection(item.id);
      if (!connection.reverseDial || this.outgoing.has(connection.id)) continue;
      const controller = new AbortController();
      const entry = { controller, configuration: JSON.stringify(connection) };
      this.outgoing.set(connection.id, entry);
      const loop = this.dial(connection, entry).finally(() => {
        if (this.outgoing.get(connection.id) === entry) this.outgoing.delete(connection.id);
      });
      this.loops.add(loop);
      void loop.finally(() => this.loops.delete(loop));
    }
  }

  /** Resolve grant→connection before accepting the claimed peer ID. Never let the peer choose a target. */
  connectionFor(grantId: string, instanceId: string): RemoteConnectionCredentials {
    const connection = this.remotes.access
      .listConnections()
      .find((item) => item.transport === "reverse" && item.reverseGrantId === grantId);
    if (!connection || connection.instanceId !== instanceId)
      throw Object.assign(new Error("Reverse peer is not configured for this grant"), {
        statusCode: 403,
      });
    return this.remotes.connection(connection.id);
  }

  accept(
    connection: RemoteConnectionCredentials,
    send: (event: ReverseEvent) => Promise<void>,
    end: () => void,
  ) {
    this.incoming.get(connection.id)?.close();
    const channel = new ReverseChannel(send);
    const entry: Incoming = {
      channel,
      acknowledged: Date.now(),
      configuration: JSON.stringify(connection),
      close: () => {
        channel.close();
        end();
        if (this.incoming.get(connection.id) === entry) {
          this.incoming.delete(connection.id);
          this.statuses.set(connection.id, { state: "disconnected" });
          this.remotes.changes.emit("catalog", connection.id);
        }
      },
    };
    this.incoming.set(connection.id, entry);
    this.denied.delete(connection.id);
    this.statuses.set(connection.id, { state: "connecting" });
    void nodeRequest<{ instanceId: string; grantId: string }>(
      connection,
      "identity",
      {},
      this.remotes.requestNode,
    )
      .then(async (identity) => {
        if (identity.instanceId !== connection.instanceId)
          throw new Error("Reverse peer identity mismatch");
        if (this.incoming.get(connection.id) !== entry) return;
        await this.remotes.access.updateIdentity(connection.id, identity);
        if (this.incoming.get(connection.id) !== entry) return;
        entry.configuration = JSON.stringify(this.remotes.connection(connection.id));
        this.statuses.set(connection.id, { state: "connected" });
        this.remotes.connect(connection.id);
      })
      .catch((error: unknown) => {
        if (this.incoming.get(connection.id) !== entry) return;
        if (error instanceof NodeHttpError && [401, 403].includes(error.status))
          this.denied.set(connection.id, error);
        entry.close();
        this.statuses.set(connection.id, { state: "error", error: String(error) });
      });
    return entry.close;
  }

  acknowledge(connection: RemoteConnectionCredentials) {
    const entry = this.incoming.get(connection.id);
    if (!entry) throw Object.assign(new Error("Reverse control is offline"), { statusCode: 409 });
    entry.acknowledged = Date.now();
  }

  isAlive(connection: RemoteConnectionCredentials): boolean {
    const entry = this.incoming.get(connection.id);
    return !!entry && Date.now() - entry.acknowledged < 45_000;
  }

  channel(connection: RemoteConnectionCredentials): ReverseChannel {
    const denied = this.denied.get(connection.id);
    if (denied) throw denied;
    if (!this.remotes.access.listGrants().some((grant) => grant.id === connection.reverseGrantId))
      throw new NodeHttpError(403, `Remote ${connection.id}: reverse access grant was revoked`);
    const channel = this.incoming.get(connection.id)?.channel;
    if (!channel) throw new Error(`Remote ${connection.id}: reverse connection is offline`);
    return channel;
  }

  transfer(connection: RemoteConnectionCredentials, id: string) {
    const transfer = this.channel(connection).transfers.get(id);
    if (!transfer) throw Object.assign(new Error("Unknown reverse transfer"), { statusCode: 404 });
    return transfer;
  }

  private async dial(connection: RemoteConnectionCredentials, dial: Dial) {
    const signal = dial.controller.signal;
    const setStatus = (status: ReverseStatus) => {
      if (this.outgoing.get(connection.id) === dial) this.statuses.set(connection.id, status);
    };
    let attempts = 0;
    while (!signal.aborted && !this.stopped) {
      const tasks = new Map<string, AbortController>();
      const stopTasks = () => {
        for (const task of tasks.values()) task.abort();
      };
      signal.addEventListener("abort", stopTasks, { once: true });
      try {
        setStatus({ state: "connecting" });
        const attempt = new AbortController();
        const handshake = setTimeout(() => attempt.abort(), 30_000);
        const response = await fetch(new URL("api/node/reverse/control", connection.url), {
          headers: this.headers(connection),
          redirect: "error",
          signal: AbortSignal.any([signal, attempt.signal]),
        }).finally(() => clearTimeout(handshake));
        if (!response.ok) throw new Error(`Reverse control HTTP ${response.status}`);
        if (response.headers.get("x-batty-instance-id") !== connection.instanceId) {
          await response.body?.cancel();
          throw new Error("Reverse receiver identity mismatch");
        }
        attempts = 0;
        setStatus({ state: "connected" });
        await readNodeEvents(response, async (value) => {
          const event = value as ReverseEvent;
          if (event.type === "ping") {
            const acknowledged = await fetch(new URL("api/node/reverse/alive", connection.url), {
              method: "POST",
              headers: this.headers(connection),
              signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
              redirect: "error",
            });
            if (!acknowledged.ok) throw new Error(`Reverse heartbeat HTTP ${acknowledged.status}`);
            await acknowledged.body?.cancel();
            return;
          }
          if (event.type === "cancel") {
            tasks.get(event.id)?.abort();
            return;
          }
          if (
            event.type !== "request" ||
            typeof event.id !== "string" ||
            tasks.has(event.id) ||
            typeof event.route !== "string" ||
            !isNodeRoute(event.route, event.method) ||
            !Array.isArray(event.headers) ||
            typeof event.body !== "boolean"
          )
            throw new Error("Invalid reverse control request");
          const task = new AbortController();
          tasks.set(event.id, task);
          void this.bridge(connection, event, task.signal)
            .catch((error: unknown) => {
              if (!task.signal.aborted) setStatus({ state: "error", error: String(error) });
            })
            .finally(() => tasks.delete(event.id));
        });
        if (!signal.aborted) throw new Error("Reverse control disconnected");
      } catch (error) {
        if (!signal.aborted) setStatus({ state: "error", error: String(error) });
      } finally {
        signal.removeEventListener("abort", stopTasks);
        stopTasks();
      }
      if (signal.aborted) break;
      // Reconnect transport only: never replay a command or an interrupted response.
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
    setStatus({ state: "disconnected" });
  }

  private headers(connection: RemoteConnectionCredentials) {
    return {
      authorization: `Bearer ${connection.token}`,
      "x-batty-instance-id": this.remotes.access.identity().instanceId,
    };
  }

  private async bridge(
    connection: RemoteConnectionCredentials,
    event: Extract<ReverseEvent, { type: "request" }>,
    signal: AbortSignal,
  ) {
    const endpoint = new URL(
      `api/node/reverse/transfers/${encodeURIComponent(event.id)}`,
      connection.url,
    );
    let response: Response;
    try {
      let body: ReadableStream<Uint8Array> | null = null;
      if (event.body) {
        const upload = await fetch(endpoint, {
          headers: this.headers(connection),
          signal,
          redirect: "error",
        });
        if (!upload.ok) throw new Error(`Reverse request body HTTP ${upload.status}`);
        body = upload.body;
      }
      // Fixed loopback destination and independently checked node route; no peer-supplied URL.
      const supplied = new Headers(event.headers);
      const headers = new Headers();
      for (const name of ["authorization", "content-type"]) {
        const value = supplied.get(name);
        if (value !== null) headers.set(name, value);
      }
      response = await fetch(new URL(`api/node/${event.route}`, this.localUrl!), {
        method: event.method,
        headers,
        body,
        signal,
        redirect: "error",
        ...(body ? { duplex: "half" } : {}),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      response = new Response(`Reverse node request failed: ${String(error)}`, { status: 502 });
    }
    const uploaded = await fetch(endpoint, {
      method: "POST",
      headers: {
        ...this.headers(connection),
        "content-type": "application/x-batty-reverse",
        "x-batty-response": responseMetadata(response),
      },
      body: response.body,
      signal,
      redirect: "error",
      ...(response.body ? { duplex: "half" } : {}),
    });
    if (!uploaded.ok) throw new Error(`Reverse response HTTP ${uploaded.status}`);
    await uploaded.body?.cancel();
  }

  async close() {
    this.stopped = true;
    for (const incoming of this.incoming.values()) incoming.close();
    for (const outgoing of this.outgoing.values()) outgoing.controller.abort();
    await Promise.allSettled(this.loops);
  }
}
