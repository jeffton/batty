import { afterEach, expect, test, vi } from "vite-plus/test";
import { SocketEventSource } from "./socket-event-source";
import { socketFetch } from "./socket-fetch";

vi.mock("./socket-fetch", () => ({ socketFetch: vi.fn() }));
afterEach(() => vi.resetAllMocks());

function stream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    cancel,
  });
  vi.mocked(socketFetch).mockResolvedValue(new Response(body));
  return { controller, cancel };
}
const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

test("parses split UTF-8, CRLF, named events and multiline data without HTTP EventSource", async () => {
  const { controller, cancel } = stream();
  const source = new SocketEventSource("/api/main/events?after=12");
  const opened = vi.fn();
  const message = vi.fn();
  const heartbeat = vi.fn();
  source.onopen = opened;
  source.onmessage = message;
  source.addEventListener("heartbeat", heartbeat);
  await tick();
  const bytes = new TextEncoder().encode(
    ": comment\r\nevent: heartbeat\r\ndata: {}\r\n\r\nid: 13\r\ndata: fæ\r\ndata: two\r\n\r\n",
  );
  for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(opened).toHaveBeenCalledOnce();
  expect(heartbeat).toHaveBeenCalledOnce();
  expect(message).toHaveBeenCalledOnce();
  expect(message.mock.calls[0]![0]).toMatchObject({ data: "fæ\ntwo", lastEventId: "13" });
  source.close();
  await tick();
  expect(source.readyState).toBe(SocketEventSource.CLOSED);
  expect(cancel).toHaveBeenCalledOnce();
});

test("stream EOF emits one error and leaves retries to the lifecycle", async () => {
  const { controller } = stream();
  const source = new SocketEventSource("/api/main/events");
  const error = vi.fn();
  source.onerror = error;
  await tick();
  controller.close();
  await tick();
  expect(error).toHaveBeenCalledOnce();
  expect(source.readyState).toBe(SocketEventSource.CLOSED);
  expect(socketFetch).toHaveBeenCalledOnce();
});

test("closing during the handshake aborts without open/error callbacks", async () => {
  let signal!: AbortSignal;
  vi.mocked(socketFetch).mockImplementation(
    (_input, init) =>
      new Promise((_, reject) => {
        signal = init!.signal!;
        signal.addEventListener("abort", () => reject(signal.reason));
      }),
  );
  const source = new SocketEventSource("/api/main/events");
  source.onopen = vi.fn();
  source.onerror = vi.fn();
  source.close();
  await tick();
  expect(signal.aborted).toBe(true);
  expect(source.onopen).not.toHaveBeenCalled();
  expect(source.onerror).not.toHaveBeenCalled();
});

test("HTTP authorization failures surface as connection errors, not silent fallbacks", async () => {
  vi.mocked(socketFetch).mockResolvedValue(new Response(null, { status: 401 }));
  const source = new SocketEventSource("/api/main/events");
  const error = vi.fn();
  source.onerror = error;
  await tick();
  expect(error).toHaveBeenCalledOnce();
});
