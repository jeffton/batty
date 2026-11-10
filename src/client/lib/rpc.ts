import { RpcChannel, RpcError, type RpcReply } from "@/shared/rpc-channel";
import { withBaseUrl } from "./base-url";

export type RpcCallOptions = { signal?: AbortSignal; body?: ReadableStream<Uint8Array> };
type Connection = {
  socket: WebSocket;
  channel?: RpcChannel;
  ready: Promise<RpcChannel>;
  waiters: number;
};
let connection: Connection | undefined;

function openConnection(): Connection {
  const url = new URL(withBaseUrl("/api/socket"), window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
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
        if (connection === current) connection = undefined;
        socket.close();
        reject(new RpcError("OFFLINE", "Batty socket disconnected"));
      };
      const opened = () => {
        cleanup();
        const channel = new RpcChannel(socket);
        current.channel = channel;
        void channel.closed.then(() => {
          if (connection === current) connection = undefined;
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

async function readyChannel(signal?: AbortSignal): Promise<RpcChannel> {
  signal?.throwIfAborted();
  if (connection && connection.socket.readyState > WebSocket.OPEN) connection = undefined;
  const current = (connection ??= openConnection());
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
    if (!current.waiters && current.socket.readyState === WebSocket.CONNECTING) {
      if (connection === current) connection = undefined;
      current.socket.close();
    }
  }
}

/** Calls are never replayed. A new call reconnects after a lost connection. */
export async function rpcCall<T = unknown>(
  operation: string,
  input: unknown,
  options?: RpcCallOptions,
): Promise<RpcReply<T>> {
  const channel = await readyChannel(options?.signal);
  options?.signal?.throwIfAborted();
  try {
    return await channel.call<T>(operation, input, options);
  } catch (error) {
    // Upgrade cookies are fixed for a socket generation. Do not retain a rejected identity.
    if (
      error instanceof RpcError &&
      error.code === "UNAUTHORIZED" &&
      connection?.channel === channel
    )
      closeRpcTransport();
    throw error;
  }
}

export function closeRpcTransport(): void {
  const current = connection;
  connection = undefined;
  if (current?.channel) current.channel.close();
  else current?.socket.close();
}
