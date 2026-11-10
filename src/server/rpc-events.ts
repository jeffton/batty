/** A pull-driven object stream for native subscriptions. No wire-format framing. */
export function rpcEvents(
  signal: AbortSignal,
  subscribe: (
    emit: (event: unknown) => Promise<void>,
    signal: AbortSignal,
    fail: (error: unknown) => void,
  ) => () => void,
): ReadableStream<unknown> {
  const lifetime = new AbortController();
  let stop: (() => void) | undefined;
  let controller: ReadableStreamDefaultController<unknown>;
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
  const stream = new ReadableStream<unknown>(
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
  const emit = (event: unknown) => {
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
