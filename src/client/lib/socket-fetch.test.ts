import { afterEach, expect, test, vi } from "vite-plus/test";
import { closeSocketTransport, socketFetch } from "./socket-fetch";

const { channels, request } = vi.hoisted(() => ({
  channels: [] as { end: () => void; closed: Promise<void>; close: ReturnType<typeof vi.fn> }[],
  request: vi.fn(),
}));
vi.mock("@/shared/socket-channel", () => ({
  SocketChannel: class {
    closed: Promise<void>;
    request = request;
    close: ReturnType<typeof vi.fn>;
    constructor(socket: WebSocket) {
      let end!: () => void;
      this.closed = new Promise<void>((resolve) => {
        end = resolve;
        socket.addEventListener("close", () => resolve());
      });
      this.close = vi.fn(() => {
        end();
        socket.close();
      });
      channels.push({ end, closed: this.closed, close: this.close });
    }
  },
}));
class FakeSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  readyState = FakeSocket.CONNECTING;
  binaryType = "blob";
  static instances: FakeSocket[] = [];
  constructor(readonly url: URL) {
    super();
    FakeSocket.instances.push(this);
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }
  close() {
    this.readyState = FakeSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}
afterEach(() => {
  closeSocketTransport();
  FakeSocket.instances = [];
  channels.length = 0;
  request.mockReset();
  vi.unstubAllGlobals();
  delete window.__BATTY_BASE_URL__;
});
function setup() {
  vi.stubGlobal("WebSocket", FakeSocket);
  request.mockImplementation(async () => new Response(null, { status: 204 }));
}

test("concurrent app requests share one same-origin socket and strip the app mount", async () => {
  setup();
  window.__BATTY_BASE_URL__ = "/batty";
  const first = socketFetch("/batty/api/main?after=12");
  const second = socketFetch("/batty/api/main/stop", { method: "POST" });
  expect(FakeSocket.instances).toHaveLength(1);
  expect(FakeSocket.instances[0]!.url.pathname).toBe("/batty/api/socket");
  FakeSocket.instances[0]!.open();
  await Promise.all([first, second]);
  expect(request.mock.calls.map(([path]) => path)).toEqual([
    "/api/main?after=12",
    "/api/main/stop",
  ]);
  expect(request.mock.calls[1]![1].method).toBe("POST");
});

test("aborting one pending opener does not cancel another request", async () => {
  setup();
  const controller = new AbortController();
  const cancelled = socketFetch("/api/main", { signal: controller.signal });
  const second = socketFetch("/api/models");
  const reason = new DOMException("Gone", "AbortError");
  controller.abort(reason);
  await expect(cancelled).rejects.toBe(reason);
  expect(FakeSocket.instances[0]!.readyState).toBe(FakeSocket.CONNECTING);
  FakeSocket.instances[0]!.open();
  await second;
  expect(request).toHaveBeenCalledTimes(1);
});

test("aborting the last pending opener closes the socket; the next call reconnects", async () => {
  setup();
  const controller = new AbortController();
  const cancelled = socketFetch("/api/main", { signal: controller.signal });
  controller.abort();
  await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
  expect(FakeSocket.instances[0]!.readyState).toBe(FakeSocket.CLOSED);
  const next = socketFetch("/api/main");
  FakeSocket.instances[1]!.open();
  await next;
  expect(request).toHaveBeenCalledTimes(1);
});

test("disconnect fails in-flight commands without replay, then permits a new request", async () => {
  setup();
  request.mockRejectedValueOnce(new Error("Disconnected"));
  const failed = socketFetch("/api/main/prompt", { method: "POST", body: "command" });
  FakeSocket.instances[0]!.open();
  await expect(failed).rejects.toThrow("Disconnected");
  FakeSocket.instances[0]!.close();
  const next = socketFetch("/api/models");
  FakeSocket.instances[1]!.open();
  await next;
  expect(request.mock.calls.map(([path]) => path)).toEqual(["/api/main/prompt", "/api/models"]);
});

test("explicit close synchronously terminates the channel even when native close lingers", async () => {
  setup();
  request.mockImplementation(() =>
    channels[0]!.closed.then(() => {
      throw new Error("Socket closed");
    }),
  );
  const pending = socketFetch("/api/main/prompt", { method: "POST", body: "command" });
  const socket = FakeSocket.instances[0]!;
  socket.open();
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  const nativeClose = vi.spyOn(socket, "close").mockImplementation(() => {
    socket.readyState = 2;
  });
  closeSocketTransport();
  expect(channels[0]!.close).toHaveBeenCalledOnce();
  expect(nativeClose).toHaveBeenCalledOnce();
  expect(socket.readyState).toBe(2);
  await expect(pending).rejects.toThrow("Socket closed");

  request.mockResolvedValueOnce(new Response(null, { status: 204 }));
  const next = socketFetch("/api/models");
  FakeSocket.instances[1]!.open();
  await next;
  expect(request.mock.calls.map(([path]) => path)).toEqual(["/api/main/prompt", "/api/models"]);
});

test("multipart bodies and cancellation reach the channel unchanged", async () => {
  setup();
  const body = new FormData();
  body.set("text", "hello");
  body.set("files", new File(["contents"], "example.txt"));
  const controller = new AbortController();
  const result = socketFetch("/api/main/prompt", {
    method: "POST",
    body,
    signal: controller.signal,
  });
  FakeSocket.instances[0]!.open();
  await result;
  const submitted = request.mock.calls[0]![1] as Request;
  expect(submitted.headers.get("content-type")).toContain("multipart/form-data; boundary=");
  const form = await submitted.formData();
  expect(form.get("text")).toBe("hello");
  expect(await (form.get("files") as File).text()).toBe("contents");
  controller.abort();
  expect(submitted.signal.aborted).toBe(true);
});

test("pre-aborted and cross-origin requests never open a socket", async () => {
  setup();
  await expect(socketFetch("/api/main", { signal: AbortSignal.abort() })).rejects.toMatchObject({
    name: "AbortError",
  });
  await expect(socketFetch("https://foreign.test/api/main")).rejects.toThrow("same origin");
  expect(FakeSocket.instances).toHaveLength(0);
});
