import { expect, test, vi } from "vite-plus/test";
import { withNodeDeadline } from "./remote-workers";
import type { RpcReply } from "../shared/rpc";

function untilAborted(signal: AbortSignal): Promise<RpcReply> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

test("native status handshake keeps its deadline with caller cancellation", async () => {
  vi.useFakeTimers();
  try {
    const caller = new AbortController();
    const rejected = expect(
      withNodeDeadline({ signal: caller.signal }, untilAborted),
    ).rejects.toMatchObject({ code: "OFFLINE" });
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(caller.signal.aborted).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test("native binary uploads retain their longer budget and caller cancellation", async () => {
  vi.useFakeTimers();
  try {
    const caller = new AbortController();
    let signal!: AbortSignal;
    const pending = withNodeDeadline(
      { body: new ReadableStream(), signal: caller.signal },
      (value) => {
        signal = value;
        return untilAborted(value);
      },
    );
    const rejected = expect(pending).rejects.toThrow("Canceled upload");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(signal.aborted).toBe(false);
    caller.abort(new Error("Canceled upload"));
    await rejected;
    expect(signal.aborted).toBe(true);
    const deadline = expect(
      withNodeDeadline({ body: new ReadableStream() }, untilAborted),
    ).rejects.toMatchObject({ code: "OFFLINE" });
    await vi.advanceTimersByTimeAsync(300_000);
    await deadline;
  } finally {
    vi.useRealTimers();
  }
});

test("a returned native subscription has no handshake lifetime limit", async () => {
  vi.useFakeTimers();
  try {
    const caller = new AbortController();
    let liveSignal!: AbortSignal;
    const events = new ReadableStream<unknown>();
    const reply = await withNodeDeadline({ signal: caller.signal }, async (signal) => {
      liveSignal = signal;
      return { value: null, events };
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(liveSignal.aborted).toBe(false);
    expect(reply.events).toBe(events);
    caller.abort();
    expect(liveSignal.aborted).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
