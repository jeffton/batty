import { RpcError } from "./channel";

/** A pull-driven object stream for native subscriptions. No wire-format framing. */
export function rpcEvents<T = unknown>(
  signal: AbortSignal,
  subscribe: (
    emit: (event: T) => Promise<void>,
    signal: AbortSignal,
    fail: (error: unknown) => void,
  ) => () => void,
): ReadableStream<T> {
  const lifetime = new AbortController();
  let stop: (() => void) | undefined;
  let controller: ReadableStreamDefaultController<T>;
  let wake: (() => void) | undefined;
  let demand = false;
  let pending = Promise.resolve();
  const finish = (mode: "close" | "error" | "cancel", error?: unknown) => {
    if (lifetime.signal.aborted) return;
    lifetime.abort(error);
    signal.removeEventListener("abort", abort);
    wake?.();
    stop?.();
    if (mode === "error") controller.error(error);
    else if (mode === "close") controller.close();
  };
  const abort = () => finish("close");
  const stream = new ReadableStream<T>(
    {
      start(value) {
        controller = value;
      },
      pull() {
        demand = true;
        wake?.();
      },
      cancel() {
        finish("cancel");
      },
    },
    { highWaterMark: 0 },
  );
  const emit = (event: T) => {
    pending = pending.then(async () => {
      while (!demand && !lifetime.signal.aborted) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
      if (lifetime.signal.aborted) return;
      demand = false;
      controller.enqueue(event);
    });
    return pending;
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  else {
    try {
      stop = subscribe(emit, lifetime.signal, (error) => finish("error", error));
      if (lifetime.signal.aborted) stop();
    } catch (error) {
      finish("error", error);
    }
  }
  return stream;
}

/** Split a concatenated byte body by manifest lengths without buffering whole files.
 * Parts must be consumed sequentially before advancing the outer iterator.
 */
export async function* splitByteStream(
  body: ReadableStream<Uint8Array>,
  sizes: Iterable<number>,
  signal: AbortSignal,
): AsyncGenerator<AsyncIterable<Uint8Array>> {
  const reader = body.getReader();
  let pending: Uint8Array = new Uint8Array();
  let ended = false;
  let failed = false;
  let cancellation: Promise<void> | undefined;
  const abort = () => {
    cancellation = reader.cancel(signal.reason);
    // Observe rejection immediately; finally awaits cleanup while preserving the read error.
    void cancellation.catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    for (const size of sizes) {
      yield (async function* () {
        let remaining = size;
        while (remaining > 0) {
          signal.throwIfAborted();
          if (!pending.byteLength) {
            const chunk = await reader.read();
            signal.throwIfAborted();
            if (chunk.done) throw new RpcError("BAD_INPUT", "Incomplete file bytes");
            pending = chunk.value;
            continue;
          }
          const length = Math.min(remaining, pending.byteLength);
          const part = pending.subarray(0, length);
          pending = pending.subarray(length);
          remaining -= length;
          yield part;
        }
      })();
    }
    signal.throwIfAborted();
    if (pending.byteLength) throw new RpcError("BAD_INPUT", "Unexpected file bytes");
    while (true) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      if (chunk.value.byteLength) throw new RpcError("BAD_INPUT", "Unexpected file bytes");
    }
    ended = true;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    try {
      if (!ended) {
        const cleanup = cancellation ?? reader.cancel();
        // A source failure takes precedence; otherwise cancellation failure propagates.
        await (failed ? cleanup.catch(() => {}) : cleanup);
      }
    } finally {
      reader.releaseLock();
    }
  }
}
