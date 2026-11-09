import { SocketChannel } from "@/shared/socket-channel";
import { stripBaseUrl, withBaseUrl } from "./base-url";

type Connection = {
  socket: WebSocket;
  channel?: SocketChannel;
  ready: Promise<SocketChannel>;
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
    ready: new Promise<SocketChannel>((resolve, reject) => {
      const cleanup = () => {
        socket.removeEventListener("open", opened);
        socket.removeEventListener("error", failed);
        socket.removeEventListener("close", failed);
      };
      const failed = () => {
        cleanup();
        if (connection === current) connection = undefined;
        socket.close();
        reject(new Error("Batty socket disconnected"));
      };
      const opened = () => {
        cleanup();
        const channel = new SocketChannel(socket);
        current.channel = channel;
        void channel.closed
          .finally(() => {
            if (connection === current) connection = undefined;
          })
          .catch(() => {});
        resolve(channel);
      };
      socket.addEventListener("open", opened);
      socket.addEventListener("error", failed);
      socket.addEventListener("close", failed);
    }),
  };
  return current;
}

async function readyChannel(signal: AbortSignal): Promise<SocketChannel> {
  signal.throwIfAborted();
  if (connection && connection.socket.readyState > WebSocket.OPEN) connection = undefined;
  const current = (connection ??= openConnection());
  current.waiters++;
  let aborted: (() => void) | undefined;
  try {
    return await Promise.race([
      current.ready,
      new Promise<never>((_, reject) => {
        aborted = () => reject(signal.reason);
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) aborted();
      }),
    ]);
  } finally {
    if (aborted) signal.removeEventListener("abort", aborted);
    current.waiters--;
    if (!current.waiters && current.socket.readyState === WebSocket.CONNECTING) {
      if (connection === current) connection = undefined;
      current.socket.close();
    }
  }
}

/** One authenticated app socket. A lost request fails; only a new request reconnects. */
export async function socketFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
  if (url.origin !== window.location.origin) throw new Error("Batty socket requires same origin");
  const path = stripBaseUrl(url.pathname);
  if (!path) throw new Error("Request is outside the Batty app");
  const request = new Request(input instanceof Request ? input : url, init);
  const channel = await readyChannel(request.signal);
  request.signal.throwIfAborted();
  return channel.request(`${path}${url.search}`, request);
}

export function closeSocketTransport(): void {
  const current = connection;
  connection = undefined;
  if (current?.channel) current.channel.close();
  else current?.socket.close();
}
