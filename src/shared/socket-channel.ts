/** A duplex Request/Response channel shared by browser clients and paired nodes.
 * Bodies are binary and pull-driven. A sliding 1 MiB credit window pipelines
 * 64 KiB frames (the bandwidth-delay product of 100 Mbit/s at ~80 ms RTT).
 * This bounds transport buffering per body, not file size; the producer retains
 * ownership of its current source chunk. No credits flow before the first read.
 * Disconnect rejects volatile calls; durable jobs/cursors live above this.
 */
export const SOCKET_CHUNK_BYTES = 64 * 1024;
export const SOCKET_MAX_FRAME_BYTES = SOCKET_CHUNK_BYTES + 37;
export const SOCKET_WINDOW_CHUNKS = 16;

type Side = "request" | "response";
type Frame =
  | {
      type: "request";
      id: string;
      path: string;
      method: string;
      headers: [string, string][];
      body: boolean;
    }
  | { type: "response"; id: string; status: number; headers: [string, string][]; body: boolean }
  | { type: "pull"; id: string; side: Side; count: number }
  | { type: "end"; id: string; side: Side }
  | { type: "cancel" | "error"; id: string; message: string }
  | { type: "ping" }
  | { type: "pong" };

export interface ChannelSocket {
  binaryType: string;
  send(data: string | Uint8Array<ArrayBuffer>): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close" | "error", listener: () => void): void;
}
type Outbound = {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  rest?: Uint8Array;
  reading: boolean;
  credits: number;
  ended?: boolean;
};
type Inbound = {
  stream: ReadableStream<Uint8Array>;
  controller: ReadableStreamDefaultController<Uint8Array>;
  credits: number;
  queue: Uint8Array[];
  pending: boolean;
  ended: boolean;
};
type Exchange = {
  controller: AbortController;
  outgoing: Partial<Record<Side, Outbound>>;
  incoming: Partial<Record<Side, Inbound>>;
  resolve?: (response: Response) => void;
  reject?: (error: Error) => void;
  detach?: () => void;
};
export type SocketHandler = (path: string, request: Request) => Promise<Response>;

export class SocketChannel {
  private readonly exchanges = new Map<string, Exchange>();
  private ended = false;
  private lastActivity = Date.now();
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private finishClosed!: () => void;
  readonly closed = new Promise<void>((resolve) => {
    this.finishClosed = resolve;
  });

  constructor(
    private readonly socket: ChannelSocket,
    options: { handle?: SocketHandler } = {},
  ) {
    socket.binaryType = "arraybuffer";
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastActivity > 45_000)
        this.close(new Error("Socket heartbeat expired"));
      else this.send({ type: "ping" });
    }, 15_000);
    this.heartbeat.unref?.();
    socket.addEventListener("message", (event) => {
      try {
        this.lastActivity = Date.now();
        if (typeof event.data === "string")
          this.receive(JSON.parse(event.data) as Frame, options.handle);
        else if (event.data instanceof ArrayBuffer) this.receiveBody(new Uint8Array(event.data));
        else throw new Error("Unsupported socket frame");
      } catch {
        this.close(new Error("Invalid socket protocol frame"));
      }
    });
    socket.addEventListener("close", () => this.close(new Error("Socket disconnected")));
    socket.addEventListener("error", () => this.close(new Error("Socket failed")));
  }

  request(path: string, request: Request): Promise<Response> {
    if (this.ended) return Promise.reject(new Error("Socket is offline"));
    request.signal.throwIfAborted();
    const id = crypto.randomUUID();
    return new Promise<Response>((resolve, reject) => {
      const entry: Exchange = {
        controller: new AbortController(),
        outgoing: {},
        incoming: {},
        resolve,
        reject,
      };
      this.exchanges.set(id, entry);
      const abort = () => this.cancel(id, request.signal.reason);
      request.signal.addEventListener("abort", abort, { once: true });
      entry.detach = () => request.signal.removeEventListener("abort", abort);
      if (request.body)
        entry.outgoing.request = { reader: request.body.getReader(), reading: false, credits: 0 };
      try {
        this.send({
          type: "request",
          id,
          path,
          method: request.method,
          headers: [...request.headers],
          body: !!request.body,
        });
      } catch (error) {
        this.cancel(id, error as Error);
      }
    });
  }

  close(error = new Error("Socket closed")) {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.heartbeat);
    for (const id of this.exchanges.keys()) this.dispose(id, error);
    this.socket.close();
    this.finishClosed();
  }

  private send(frame: Frame) {
    if (this.ended) throw new Error("Socket is offline");
    this.socket.send(JSON.stringify(frame));
  }

  private stream(id: string, side: Side, entry: Exchange) {
    let inbound!: Inbound;
    const stream = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          inbound = {
            stream: undefined!,
            controller,
            credits: 0,
            queue: [],
            pending: false,
            ended: false,
          };
        },
        pull: () => {
          if (!this.exchanges.has(id)) return;
          const chunk = inbound.queue.shift();
          if (chunk) inbound.controller.enqueue(chunk);
          else inbound.pending = true;
          if (inbound.ended) {
            this.finishIncoming(id, side, entry);
            return;
          }
          const count = SOCKET_WINDOW_CHUNKS - inbound.queue.length - inbound.credits;
          if (count) {
            inbound.credits += count;
            this.send({ type: "pull", id, side, count });
          }
        },
        cancel: () => this.cancel(id, new Error("Socket body cancelled")),
      },
      { highWaterMark: 0 },
    );
    inbound.stream = stream;
    entry.incoming[side] = inbound;
    return stream;
  }

  private receive(frame: Frame, handle?: SocketHandler) {
    if (!frame || typeof frame !== "object") throw new Error("Invalid frame");
    if (frame.type === "ping") {
      this.send({ type: "pong" });
      return;
    }
    if (frame.type === "pong") return;
    if (!/^[0-9a-f-]{36}$/.test(frame.id)) throw new Error("Invalid frame ID");
    if (frame.type === "request") {
      if (
        !handle ||
        this.exchanges.has(frame.id) ||
        typeof frame.path !== "string" ||
        typeof frame.method !== "string" ||
        typeof frame.body !== "boolean"
      )
        throw new Error("Invalid request");
      const entry: Exchange = { controller: new AbortController(), outgoing: {}, incoming: {} };
      this.exchanges.set(frame.id, entry);
      const request = new Request("http://batty.invalid/", {
        method: frame.method,
        headers: frame.headers,
        signal: entry.controller.signal,
        ...(frame.body ? { body: this.stream(frame.id, "request", entry), duplex: "half" } : {}),
      });
      void handle(frame.path, request)
        .then((response) => {
          if (!this.exchanges.has(frame.id)) {
            void response.body?.cancel();
            return;
          }
          if (response.body)
            entry.outgoing.response = {
              reader: response.body.getReader(),
              reading: false,
              credits: 0,
            };
          const headers = [...response.headers].filter(
            ([name]) =>
              ![
                "content-length",
                "content-encoding",
                "transfer-encoding",
                "connection",
                "set-cookie",
              ].includes(name),
          );
          this.send({
            type: "response",
            id: frame.id,
            status: response.status,
            headers,
            body: !!response.body,
          });
          if (!response.body) this.dispose(frame.id);
        })
        .catch((error: unknown) =>
          this.cancel(frame.id, error instanceof Error ? error : new Error(String(error)), "error"),
        );
      return;
    }
    const entry = this.exchanges.get(frame.id);
    if (!entry) return; // Cancellation and the final credit can cross in flight.
    switch (frame.type) {
      case "response": {
        if (!entry.resolve || typeof frame.body !== "boolean")
          throw new Error("Unexpected response");
        const response = new Response(
          frame.body ? this.stream(frame.id, "response", entry) : null,
          { status: frame.status, headers: frame.headers },
        );
        entry.resolve(response);
        entry.resolve = undefined;
        if (!frame.body) this.dispose(frame.id);
        break;
      }
      case "pull":
        if (frame.side !== "request" && frame.side !== "response")
          throw new Error("Invalid stream side");
        {
          const outgoing = entry.outgoing[frame.side];
          if (outgoing?.ended) return; // Final credit can cross the stream's EOF.
          if (
            !outgoing ||
            !Number.isInteger(frame.count) ||
            frame.count < 1 ||
            outgoing.credits + frame.count > SOCKET_WINDOW_CHUNKS
          )
            throw new Error("Invalid body credit window");
          outgoing.credits += frame.count;
          void this.produce(frame.id, frame.side, entry);
        }
        break;
      case "end": {
        const incoming = entry.incoming[frame.side];
        if (!incoming || incoming.ended || !incoming.credits)
          throw new Error("Unexpected stream end");
        incoming.ended = true;
        this.finishIncoming(frame.id, frame.side, entry);
        break;
      }
      case "error":
      case "cancel":
        this.dispose(frame.id, new Error(frame.message));
        break;
      default:
        throw new Error("Unknown frame");
    }
  }

  private receiveBody(frame: Uint8Array) {
    if (frame.byteLength < 38 || frame.byteLength > SOCKET_MAX_FRAME_BYTES || frame[0]! > 1)
      throw new Error("Invalid binary frame");
    const side: Side = frame[0] === 0 ? "request" : "response";
    const id = new TextDecoder().decode(frame.subarray(1, 37));
    const entry = this.exchanges.get(id);
    if (!entry) return;
    const incoming = entry.incoming[side];
    if (!incoming || incoming.ended || !incoming.credits)
      throw new Error("Body sent without credit");
    incoming.credits--;
    const chunk = frame.subarray(37);
    if (incoming.pending) {
      incoming.pending = false;
      incoming.controller.enqueue(chunk);
    } else incoming.queue.push(chunk);
  }

  private finishIncoming(id: string, side: Side, entry: Exchange) {
    const incoming = entry.incoming[side]!;
    if (incoming.queue.length) return;
    incoming.controller.close();
    delete entry.incoming[side];
    if (side === "response") this.dispose(id);
  }

  private async produce(id: string, side: Side, entry: Exchange) {
    const outgoing = entry.outgoing[side];
    if (!outgoing || outgoing.reading) return;
    outgoing.reading = true;
    try {
      while (outgoing.credits && this.exchanges.has(id)) {
        let bytes = outgoing.rest;
        while (!bytes?.length) {
          const chunk = await outgoing.reader.read();
          if (!this.exchanges.has(id)) return;
          if (chunk.done) {
            this.send({ type: "end", id, side });
            outgoing.ended = true;
            outgoing.credits = 0;
            outgoing.reader.releaseLock();
            if (side === "response") this.dispose(id);
            return;
          }
          bytes = chunk.value;
        }
        const part = bytes.subarray(0, SOCKET_CHUNK_BYTES);
        outgoing.rest = bytes.length > part.length ? bytes.subarray(part.length) : undefined;
        const frame = new Uint8Array(37 + part.length);
        frame[0] = side === "request" ? 0 : 1;
        frame.set(new TextEncoder().encode(id), 1);
        frame.set(part, 37);
        outgoing.credits--;
        this.socket.send(frame);
      }
    } catch (error) {
      this.cancel(id, error as Error, "error");
    } finally {
      outgoing.reading = false;
    }
  }

  private cancel(id: string, error: Error, type: "cancel" | "error" = "cancel") {
    if (!this.exchanges.has(id)) return;
    if (!this.ended)
      this.send({
        type,
        id,
        message: type === "error" ? "Socket request failed" : "Socket request cancelled",
      });
    this.dispose(id, error);
  }

  private dispose(id: string, error?: Error) {
    const entry = this.exchanges.get(id);
    if (!entry) return;
    this.exchanges.delete(id);
    entry.detach?.();
    entry.controller.abort(error);
    if (error) entry.reject?.(error);
    for (const outgoing of Object.values(entry.outgoing))
      if (!outgoing.ended) void outgoing.reader.cancel(error).catch(() => {});
    for (const incoming of Object.values(entry.incoming))
      incoming.controller.error(error ?? new Error("Exchange completed"));
  }
}
