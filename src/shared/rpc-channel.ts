/** Native duplex RPC. Calls/results/events are JSON; byte streams are binary.
 * Each stream starts on its first read, then uses a sliding 16-item credit
 * window. Binary items are <=64 KiB: 1 MiB covers ~100 Mbit/s at 80 ms RTT.
 * The window bounds transport buffering, not file length or producer chunks.
 * Event buffering is bounded in items; event payloads belong to the domain.
 * Disconnect fails volatile calls. Durable jobs/cursors live above this layer.
 */
export const RPC_CHUNK_BYTES = 64 * 1024;
export const RPC_MAX_FRAME_BYTES = RPC_CHUNK_BYTES + 37;
export const RPC_WINDOW_CHUNKS = 16;

export interface ChannelSocket {
  binaryType: string;
  send(data: string | Uint8Array<ArrayBuffer>): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close" | "error", listener: () => void): void;
}

export type RpcContext = { signal: AbortSignal; body?: ReadableStream<Uint8Array> };
export type RpcReply<T = unknown> = {
  value: T;
  body?: ReadableStream<Uint8Array>;
  events?: ReadableStream<unknown>;
};
export type RpcHandler = (
  operation: string,
  input: unknown,
  context: RpcContext,
) => Promise<RpcReply>;

export class RpcError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

type Lane = "input" | "body" | "events";
type Frame =
  | { type: "call"; id: string; operation: string; input: unknown; body: boolean }
  | { type: "result"; id: string; value: unknown; body: boolean; events: boolean }
  | { type: "event"; id: string; value: unknown }
  | { type: "credit"; id: string; lane: Lane; count: number }
  | { type: "end"; id: string; lane: Lane }
  | { type: "error" | "cancel"; id: string; code: string; message: string; details?: unknown }
  | { type: "ping" | "pong" };

type Outbound = {
  reader: ReadableStreamDefaultReader<unknown>;
  rest?: Uint8Array;
  credits: number;
  reading: boolean;
  ended: boolean;
};
type Inbound = {
  controller: ReadableStreamDefaultController<unknown>;
  queue: unknown[];
  credits: number;
  pending: boolean;
  ended: boolean;
};
type Call = {
  controller: AbortController;
  incoming: Partial<Record<Lane, Inbound>>;
  outgoing: Partial<Record<Lane, Outbound>>;
  result: boolean;
  resolve?: (reply: RpcReply) => void;
  reject?: (error: unknown) => void;
  detach?: () => void;
};

function isLane(value: unknown): value is Lane {
  return value === "input" || value === "body" || value === "events";
}

function asError(value: unknown): Error {
  return value instanceof Error
    ? value
    : new RpcError("CANCELLED", String(value ?? "RPC call cancelled"));
}

export class RpcChannel {
  private readonly calls = new Map<string, Call>();
  private ended = false;
  private lastActivity = Date.now();
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private finishClosed!: () => void;
  readonly closed = new Promise<void>((resolve) => {
    this.finishClosed = resolve;
  });

  constructor(
    private readonly socket: ChannelSocket,
    options: { handle?: RpcHandler } = {},
  ) {
    socket.binaryType = "arraybuffer";
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastActivity >= 45_000)
        this.close(new RpcError("OFFLINE", "RPC heartbeat expired"));
      else {
        try {
          this.send({ type: "ping" });
        } catch {
          this.close(new RpcError("OFFLINE", "RPC socket failed"));
        }
      }
    }, 15_000);
    this.heartbeat.unref?.();
    socket.addEventListener("message", (event) => {
      if (this.ended) return;
      try {
        if (typeof event.data === "string")
          this.receive(JSON.parse(event.data) as Frame, options.handle);
        else if (event.data instanceof ArrayBuffer) this.receiveBytes(new Uint8Array(event.data));
        else throw new Error("Unsupported frame");
        this.lastActivity = Date.now();
      } catch {
        this.close(new RpcError("BAD_INPUT", "Invalid RPC protocol frame"));
      }
    });
    socket.addEventListener("close", () =>
      this.close(new RpcError("OFFLINE", "RPC socket disconnected")),
    );
    socket.addEventListener("error", () =>
      this.close(new RpcError("OFFLINE", "RPC socket failed")),
    );
  }

  call<T = unknown>(
    operation: string,
    input: unknown,
    options: { signal?: AbortSignal; body?: ReadableStream<Uint8Array> } = {},
  ): Promise<RpcReply<T>> {
    if (this.ended) return Promise.reject(new RpcError("OFFLINE", "RPC socket is offline"));
    if (options.signal?.aborted) return Promise.reject(options.signal.reason);
    const id = crypto.randomUUID();
    return new Promise<RpcReply<T>>((resolve, reject) => {
      const entry = this.createCall();
      entry.resolve = (reply) => resolve(reply as RpcReply<T>);
      entry.reject = reject;
      this.calls.set(id, entry);
      if (options.signal) {
        const signal = options.signal;
        const abort = () => this.fail(id, signal.reason, "cancel");
        signal.addEventListener("abort", abort, { once: true });
        entry.detach = () => signal.removeEventListener("abort", abort);
      }
      try {
        if (options.body) entry.outgoing.input = this.outbound(options.body);
        this.send({ type: "call", id, operation, input, body: !!options.body });
      } catch (error) {
        this.fail(id, asError(error), "error");
      }
    });
  }

  close(error: Error = new RpcError("OFFLINE", "RPC socket closed")) {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.heartbeat);
    for (const id of this.calls.keys()) this.dispose(id, error);
    this.socket.close();
    this.finishClosed();
  }

  private createCall(): Call {
    return { controller: new AbortController(), incoming: {}, outgoing: {}, result: false };
  }

  private outbound(stream: ReadableStream<unknown>): Outbound {
    return { reader: stream.getReader(), credits: 0, reading: false, ended: false };
  }

  private send(frame: Frame) {
    if (this.ended) throw new RpcError("OFFLINE", "RPC socket is offline");
    this.socket.send(JSON.stringify(frame));
  }

  private stream<T>(id: string, lane: Lane, entry: Call): ReadableStream<T> {
    let inbound!: Inbound;
    return new ReadableStream<T>(
      {
        start: (controller) => {
          inbound = {
            controller: controller as ReadableStreamDefaultController<unknown>,
            queue: [],
            credits: 0,
            pending: false,
            ended: false,
          };
          entry.incoming[lane] = inbound;
        },
        pull: () => {
          if (!this.calls.has(id)) return;
          if (inbound.queue.length) inbound.controller.enqueue(inbound.queue.shift());
          else inbound.pending = true;
          if (inbound.ended) {
            this.finishIncoming(id, lane, entry);
            return;
          }
          const count = RPC_WINDOW_CHUNKS - inbound.queue.length - inbound.credits;
          if (count) {
            inbound.credits += count;
            try {
              this.send({ type: "credit", id, lane, count });
            } catch (error) {
              this.close(asError(error));
            }
          }
        },
        cancel: (reason) => this.fail(id, asError(reason), "cancel"),
      },
      { highWaterMark: 0 },
    );
  }

  private receive(frame: Frame, handle?: RpcHandler) {
    if (!frame || typeof frame !== "object") throw new Error("Invalid frame");
    if (frame.type === "ping") {
      this.send({ type: "pong" });
      return;
    }
    if (frame.type === "pong") return;
    if (!("id" in frame) || !/^[0-9a-f-]{36}$/.test(frame.id)) throw new Error("Invalid call ID");
    if (frame.type === "call") {
      if (
        this.calls.has(frame.id) ||
        typeof frame.operation !== "string" ||
        !frame.operation ||
        typeof frame.body !== "boolean"
      )
        throw new Error("Invalid call");
      const entry = this.createCall();
      this.calls.set(frame.id, entry);
      if (!handle) {
        this.fail(frame.id, new RpcError("NOT_FOUND", "RPC operation unavailable"), "error");
        return;
      }
      const context: RpcContext = {
        signal: entry.controller.signal,
        ...(frame.body ? { body: this.stream<Uint8Array>(frame.id, "input", entry) } : {}),
      };
      void Promise.resolve()
        .then(() => handle(frame.operation, frame.input, context))
        .then(async (reply) => {
          if (!this.calls.has(frame.id)) {
            await Promise.all([reply.body?.cancel(), reply.events?.cancel()]);
            return;
          }
          if (reply.body) entry.outgoing.body = this.outbound(reply.body);
          if (reply.events) entry.outgoing.events = this.outbound(reply.events);
          this.send({
            type: "result",
            id: frame.id,
            value: reply.value,
            body: !!reply.body,
            events: !!reply.events,
          });
          entry.result = true;
          this.complete(frame.id, entry);
        })
        .catch((error: unknown) => this.fail(frame.id, asError(error), "error"));
      return;
    }
    const entry = this.calls.get(frame.id);
    if (!entry) return; // Cancellation/EOF may cross in-flight credits or chunks.
    switch (frame.type) {
      case "result": {
        if (
          !entry.resolve ||
          entry.result ||
          typeof frame.body !== "boolean" ||
          typeof frame.events !== "boolean"
        )
          throw new Error("Unexpected result");
        const reply: RpcReply = {
          value: frame.value,
          ...(frame.body ? { body: this.stream<Uint8Array>(frame.id, "body", entry) } : {}),
          ...(frame.events ? { events: this.stream<unknown>(frame.id, "events", entry) } : {}),
        };
        entry.result = true;
        entry.resolve(reply);
        entry.resolve = undefined;
        this.complete(frame.id, entry);
        break;
      }
      case "credit": {
        if (
          !isLane(frame.lane) ||
          !Number.isInteger(frame.count) ||
          frame.count < 1 ||
          frame.count > RPC_WINDOW_CHUNKS
        )
          throw new Error("Invalid stream credit");
        const outgoing = entry.outgoing[frame.lane];
        if (outgoing?.ended) return;
        if (!outgoing || outgoing.credits + frame.count > RPC_WINDOW_CHUNKS)
          throw new Error("Invalid stream window");
        outgoing.credits += frame.count;
        void this.produce(frame.id, frame.lane, entry, outgoing);
        break;
      }
      case "event":
        this.deliver(frame.id, "events", entry, frame.value);
        break;
      case "end": {
        if (!isLane(frame.lane)) throw new Error("Invalid stream lane");
        const incoming = entry.incoming[frame.lane];
        if (!incoming || incoming.ended || !incoming.credits)
          throw new Error("Unexpected stream end");
        incoming.ended = true;
        this.finishIncoming(frame.id, frame.lane, entry);
        break;
      }
      case "cancel":
      case "error": {
        if (typeof frame.code !== "string" || typeof frame.message !== "string")
          throw new Error("Invalid RPC error");
        this.dispose(frame.id, new RpcError(frame.code, frame.message, frame.details));
        break;
      }
      default:
        throw new Error("Unknown frame");
    }
  }

  private receiveBytes(frame: Uint8Array) {
    if (frame.byteLength < 38 || frame.byteLength > RPC_MAX_FRAME_BYTES || frame[0]! > 1)
      throw new Error("Invalid binary frame");
    const id = new TextDecoder().decode(frame.subarray(1, 37));
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid binary call ID");
    const entry = this.calls.get(id);
    if (entry) this.deliver(id, frame[0] === 0 ? "input" : "body", entry, frame.subarray(37));
  }

  private deliver(_id: string, lane: Lane, entry: Call, value: unknown) {
    const incoming = entry.incoming[lane];
    if (!incoming || incoming.ended || !incoming.credits)
      throw new Error("Stream item without credit");
    incoming.credits--;
    if (incoming.pending) {
      incoming.pending = false;
      incoming.controller.enqueue(value);
    } else incoming.queue.push(value);
  }

  private finishIncoming(id: string, lane: Lane, entry: Call) {
    const incoming = entry.incoming[lane]!;
    if (incoming.queue.length) return;
    incoming.controller.close();
    delete entry.incoming[lane];
    this.complete(id, entry);
  }

  private complete(id: string, entry: Call) {
    if (
      !entry.result ||
      entry.incoming.input ||
      (entry.outgoing.input && !entry.outgoing.input.ended) ||
      entry.incoming.body ||
      entry.incoming.events ||
      (entry.outgoing.body && !entry.outgoing.body.ended) ||
      (entry.outgoing.events && !entry.outgoing.events.ended)
    )
      return;
    this.dispose(id);
  }

  private async produce(id: string, lane: Lane, entry: Call, outgoing: Outbound) {
    if (outgoing.reading) return;
    outgoing.reading = true;
    try {
      while (outgoing.credits && this.calls.has(id)) {
        if (lane === "events") {
          const item = await outgoing.reader.read();
          if (!this.calls.has(id)) return;
          if (item.done) {
            this.endOutgoing(id, lane, entry, outgoing);
            return;
          }
          outgoing.credits--;
          this.send({ type: "event", id, value: item.value });
          continue;
        }
        let bytes = outgoing.rest;
        while (!bytes?.length) {
          const chunk = await outgoing.reader.read();
          if (!this.calls.has(id)) return;
          if (chunk.done) {
            this.endOutgoing(id, lane, entry, outgoing);
            return;
          }
          if (!(chunk.value instanceof Uint8Array)) throw new Error("RPC body requires bytes");
          bytes = chunk.value;
        }
        const part = bytes.subarray(0, RPC_CHUNK_BYTES);
        outgoing.rest = bytes.length > part.length ? bytes.subarray(part.length) : undefined;
        const frame = new Uint8Array(37 + part.length);
        frame[0] = lane === "input" ? 0 : 1;
        frame.set(new TextEncoder().encode(id), 1);
        frame.set(part, 37);
        outgoing.credits--;
        this.socket.send(frame);
      }
    } catch (error) {
      this.fail(id, asError(error), "error");
    } finally {
      outgoing.reading = false;
    }
  }

  private endOutgoing(id: string, lane: Lane, entry: Call, outgoing: Outbound) {
    this.send({ type: "end", id, lane });
    outgoing.ended = true;
    outgoing.credits = 0;
    outgoing.reader.releaseLock();
    this.complete(id, entry);
  }

  private fail(id: string, error: unknown, type: "error" | "cancel") {
    if (!this.calls.has(id)) return;
    try {
      if (!this.ended)
        this.send({
          type,
          id,
          code:
            error instanceof RpcError ? error.code : type === "cancel" ? "CANCELLED" : "INTERNAL",
          details: error instanceof RpcError ? error.details : undefined,
          message:
            error instanceof RpcError
              ? error.message
              : type === "cancel"
                ? "RPC call cancelled"
                : "RPC operation failed",
        });
    } catch {
      this.close(new RpcError("OFFLINE", "RPC socket failed"));
    } finally {
      this.dispose(id, error);
    }
  }

  private dispose(id: string, error?: unknown) {
    const entry = this.calls.get(id);
    if (!entry) return;
    this.calls.delete(id);
    entry.detach?.();
    if (error !== undefined) {
      entry.controller.abort(error);
      entry.reject?.(error);
    }
    for (const outgoing of Object.values(entry.outgoing)) {
      outgoing.rest = undefined;
      if (!outgoing.ended) void outgoing.reader.cancel(error).catch(() => {});
    }
    for (const incoming of Object.values(entry.incoming)) {
      incoming.queue.length = 0;
      incoming.controller.error(
        error !== undefined ? error : new RpcError("CANCELLED", "RPC call completed"),
      );
    }
  }
}
