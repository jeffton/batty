import {
  RpcChannel,
  RpcError,
  type ChannelSocket,
  type RpcCallOptions,
  type RpcReply,
} from "./channel";

import type { RpcResult } from "./registry";

/** Bind a transport to its application's shared operation contract at the wire boundary. */
export type RpcCaller<Inputs, Outputs extends Record<keyof Inputs, unknown>, Events = {}> = <
  K extends keyof Inputs & string,
>(
  operation: K,
  input: Inputs[K],
  options?: RpcCallOptions,
) => Promise<RpcResult<Outputs, Events, K>>;

export interface ClientSocket extends ChannelSocket {
  readonly readyState: number;
  addEventListener(type: "open" | "close" | "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: "open" | "close" | "error", listener: () => void): void;
}
type Connection = {
  socket: ClientSocket;
  channel?: RpcChannel;
  ready: Promise<RpcChannel>;
  waiters: number;
};

/** A lazy connection generation. Calls fail on disconnect and are never replayed.
 * Opening is shared; cancelling its last waiter closes the pending socket.
 * Credentials, reconnecting subscriptions and durable state belong to the caller.
 */
export class RpcClient {
  private connection?: Connection;

  constructor(
    private readonly connect: () => ClientSocket,
    private readonly options: { invalidate?: (error: unknown) => boolean } = {},
  ) {}

  async call<T = unknown, Event = unknown>(
    operation: string,
    input: unknown,
    options?: RpcCallOptions,
  ): Promise<RpcReply<T, Event>> {
    const channel = await this.ready(options?.signal);
    options?.signal?.throwIfAborted();
    try {
      return await channel.call<T, Event>(operation, input, options);
    } catch (error) {
      if (this.connection?.channel === channel && this.options.invalidate?.(error)) this.close();
      throw error;
    }
  }

  get connecting(): boolean {
    return this.connection?.socket.readyState === 0;
  }

  close(): void {
    const current = this.connection;
    this.connection = undefined;
    if (current?.channel) current.channel.close();
    else current?.socket.close();
  }

  private open(): Connection {
    const socket = this.connect();
    const current: Connection = {
      socket,
      waiters: 0,
      ready: new Promise<RpcChannel>((resolve, reject) => {
        const cleanup = () => {
          socket.removeEventListener("open", opened);
          socket.removeEventListener("error", failed);
          socket.removeEventListener("close", failed);
        };
        const failed = () => {
          cleanup();
          if (this.connection === current) this.connection = undefined;
          socket.close();
          reject(new RpcError("OFFLINE", "RPC socket disconnected"));
        };
        const opened = () => {
          cleanup();
          const channel = new RpcChannel(socket);
          current.channel = channel;
          void channel.closed.then(() => {
            if (this.connection === current) this.connection = undefined;
          });
          resolve(channel);
        };
        socket.addEventListener("open", opened);
        socket.addEventListener("error", failed);
        socket.addEventListener("close", failed);
      }),
    };
    return current;
  }

  private async ready(signal?: AbortSignal): Promise<RpcChannel> {
    signal?.throwIfAborted();
    if (this.connection && this.connection.socket.readyState > 1) this.connection = undefined;
    const current = (this.connection ??= this.open());
    current.waiters++;
    let aborted: (() => void) | undefined;
    try {
      if (!signal) return await current.ready;
      return await Promise.race([
        current.ready,
        new Promise<never>((_, reject) => {
          aborted = () => reject(signal.reason);
          signal.addEventListener("abort", aborted, { once: true });
          if (signal.aborted) aborted();
        }),
      ]);
    } finally {
      if (aborted) signal?.removeEventListener("abort", aborted);
      current.waiters--;
      if (!current.waiters && current.socket.readyState === 0) {
        if (this.connection === current) this.connection = undefined;
        current.socket.close();
      }
    }
  }
}
