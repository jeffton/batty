import { expect, test, vi } from "vite-plus/test";
import { fetchNodeResponse, readNodeEvents } from "./remote-workers";

const connection = { id: "peer", label: "Peer", url: "https://peer.test/", token: "test-token" };

test("status request keeps its deadline when the caller also supplies cancellation", async () => {
  vi.useFakeTimers();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("deadline")), milliseconds);
    return controller.signal;
  });
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
    async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      }),
  );
  try {
    const caller = new AbortController();
    const pending = fetchNodeResponse(connection, "assignments/1", { signal: caller.signal });
    const rejected = expect(pending).rejects.toThrow("deadline");
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(caller.signal.aborted).toBe(false);
  } finally {
    fetchMock.mockRestore();
    timeout.mockRestore();
    vi.useRealTimers();
  }
});

test("multipart uploads retain their longer budget and propagate caller cancellation", async () => {
  const deadline = vi.spyOn(AbortSignal, "timeout");
  let requestSignal!: AbortSignal;
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    requestSignal = init!.signal!;
    return new Promise<Response>((_resolve, reject) => {
      requestSignal.addEventListener("abort", () => reject(requestSignal.reason), { once: true });
    });
  });
  try {
    const caller = new AbortController();
    const pending = fetchNodeResponse(connection, "commands", {
      method: "POST",
      body: new FormData(),
      signal: caller.signal,
    });
    const rejected = expect(pending).rejects.toThrow("Canceled upload");
    expect(deadline).toHaveBeenCalledWith(300_000);
    caller.abort(new Error("Canceled upload"));
    await rejected;
    expect(requestSignal.aborted).toBe(true);
  } finally {
    fetchMock.mockRestore();
    deadline.mockRestore();
  }
});

test("event headers have a handshake deadline without limiting an active stream lifetime", async () => {
  vi.useFakeTimers();
  let liveSignal!: AbortSignal;
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementationOnce(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), {
            once: true,
          });
        }),
    )
    .mockImplementationOnce(async (_input, init) => {
      liveSignal = init!.signal!;
      return new Response("data: {}\n\n");
    });
  try {
    const caller = new AbortController();
    const failed = expect(
      fetchNodeResponse(connection, "catalog/events", { signal: caller.signal }),
    ).rejects.toThrow("headers timed out");
    await vi.advanceTimersByTimeAsync(30_000);
    await failed;
    const response = await fetchNodeResponse(connection, "catalog/events", {
      signal: caller.signal,
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(liveSignal.aborted).toBe(false);
    await readNodeEvents(response, async () => {});
    caller.abort();
    expect(liveSignal.aborted).toBe(true);
  } finally {
    fetchMock.mockRestore();
    vi.useRealTimers();
  }
});
