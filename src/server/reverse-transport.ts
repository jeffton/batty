import { randomUUID } from "node:crypto";

/** Only the existing agent API is bridgeable, never arbitrary HTTP or owner routes. */
export function isNodeRoute(route: string, method: string): boolean {
  if (method === "POST") return route === "commands" || route === "unpair";
  if (method !== "GET") return false;
  if (["identity", "workspaces", "catalog/events"].includes(route)) return true;
  if (/^assignments\/\d+$/.test(route)) return true;
  if (/^sessions\/\d+\/events(?:\?after=\d+)?$/.test(route)) return true;
  const file = /^files\/([^/?#]+)\/([^/?#]+)\/([^/?#]+)\/([^/?#]+)$/.exec(route);
  return (
    !!file &&
    file.slice(1).every((part) => {
      try {
        const decoded = decodeURIComponent(part);
        return decoded !== "." && decoded !== ".." && !/[\\/\0]/.test(decoded);
      } catch {
        return false;
      }
    })
  );
}

export type ReverseEvent =
  | { type: "unpair" }
  | { type: "ping" }
  | {
      type: "request";
      id: string;
      route: string;
      method: string;
      headers: [string, string][];
      body: boolean;
    }
  | { type: "cancel"; id: string };

type Transfer = {
  request: Request;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
  finish: (error?: Error) => void;
  bodyClaimed: boolean;
  responseClaimed: boolean;
  abortResponse?: (error: Error) => void;
};

/** Volatile, one-control-stream transport. HTTP owns flow control for every body. No replay. */
export class ReverseChannel {
  readonly transfers = new Map<string, Transfer>();
  private closed = false;

  constructor(private readonly send: (event: ReverseEvent) => Promise<void>) {}

  notifyRemoval(): Promise<void> {
    return this.send({ type: "unpair" });
  }

  request(route: string, request: Request): Promise<Response> {
    if (this.closed) return Promise.reject(new Error("Reverse connection is offline"));
    if (!isNodeRoute(route, request.method))
      return Promise.reject(new Error("Invalid reverse node route"));
    request.signal.throwIfAborted();
    const id = randomUUID();
    return new Promise<Response>((resolve, reject) => {
      const abort = () => finish(new Error("Reverse request aborted"));
      const finish = (error?: Error) => {
        if (!this.transfers.delete(id)) return;
        request.signal.removeEventListener("abort", abort);
        if (error) {
          reject(error);
          transfer.abortResponse?.(error);
          void request.body?.cancel(error).catch(() => {});
          void this.send({ type: "cancel", id }).catch(() => {});
        }
      };
      const transfer: Transfer = {
        request,
        resolve,
        reject,
        finish,
        bodyClaimed: false,
        responseClaimed: false,
      };
      this.transfers.set(id, transfer);
      request.signal.addEventListener("abort", abort, { once: true });
      void this.send({
        type: "request",
        id,
        route,
        method: request.method,
        headers: [...request.headers],
        body: request.body !== null,
      }).catch(() => finish(new Error("Reverse control stream disconnected")));
    });
  }

  close() {
    this.closed = true;
    for (const transfer of this.transfers.values())
      transfer.finish(new Error("Reverse connection disconnected"));
  }
}

export function responseMetadata(response: Response): string {
  // Native fetch decodes HTTP content encodings; wire lengths/encodings are no longer valid.
  const headers = [...response.headers].filter(
    ([name]) =>
      !["content-length", "content-encoding", "transfer-encoding", "connection"].includes(name),
  );
  return Buffer.from(JSON.stringify({ status: response.status, headers })).toString("base64url");
}

export function parseResponseMetadata(value: string): {
  status: number;
  headers: [string, string][];
} {
  const data = JSON.parse(Buffer.from(value, "base64url").toString()) as {
    status: number;
    headers: [string, string][];
  };
  if (
    !Number.isInteger(data.status) ||
    data.status < 200 ||
    data.status > 599 ||
    !Array.isArray(data.headers)
  )
    throw new Error("Invalid reverse response metadata");
  // Validate header syntax before resolving the caller's response.
  new Headers(data.headers);
  return data;
}
