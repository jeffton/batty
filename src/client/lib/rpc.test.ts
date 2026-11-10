import { afterEach, expect, test, vi } from "vite-plus/test";
import { closeRpcTransport, rpcCall } from "./rpc";
import { RpcError } from "@/shared/rpc";
const { channels, call } = vi.hoisted(() => ({
  channels: [] as { closed: Promise<void>; close: ReturnType<typeof vi.fn> }[],
  call: vi.fn(),
}));
vi.mock("@/shared/rpc/channel", async (original) => ({
  ...(await original<typeof import("@/shared/rpc/channel")>()),
  RpcChannel: class {
    closed: Promise<void>;
    call = call;
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
      channels.push({ closed: this.closed, close: this.close });
    }
  },
}));
class FakeSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  readonly cookie = document.cookie;
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
  closeRpcTransport();
  FakeSocket.instances = [];
  channels.length = 0;
  call.mockReset();
  vi.unstubAllGlobals();
  delete window.__BATTY_BASE_URL__;
});
const prompt = { kind: "prompt" as const, text: "command", clientMessageId: "test", files: [] };
function setup() {
  vi.stubGlobal("WebSocket", FakeSocket);
  call.mockResolvedValue({ value: {} });
}
test("shares one app-base socket for concurrent named calls without request envelopes", async () => {
  setup();
  window.__BATTY_BASE_URL__ = "/batty";
  const first = rpcCall("session.get", { sessionId: "main", after: "12" });
  const second = rpcCall("main.stop", {});
  expect(FakeSocket.instances).toHaveLength(1);
  expect(FakeSocket.instances[0]!.url.pathname).toBe("/batty/api/socket");
  FakeSocket.instances[0]!.open();
  await Promise.all([first, second]);
  expect(call.mock.calls).toEqual([
    ["session.get", { sessionId: "main", after: "12" }, undefined],
    ["main.stop", {}, undefined],
  ]);
});
test("one opening call can abort without cancelling another", async () => {
  setup();
  const controller = new AbortController();
  const cancelled = rpcCall("session.get", { sessionId: "main" }, { signal: controller.signal });
  const second = rpcCall("models.list", {});
  const reason = new DOMException("Gone", "AbortError");
  controller.abort(reason);
  await expect(cancelled).rejects.toBe(reason);
  expect(FakeSocket.instances[0]!.readyState).toBe(FakeSocket.CONNECTING);
  FakeSocket.instances[0]!.open();
  await second;
  expect(call).toHaveBeenCalledOnce();
});
test("aborting the last opening call closes its socket and permits a later connection", async () => {
  setup();
  const controller = new AbortController();
  const cancelled = rpcCall("session.get", { sessionId: "main" }, { signal: controller.signal });
  controller.abort();
  await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
  expect(FakeSocket.instances[0]!.readyState).toBe(FakeSocket.CLOSED);
  const next = rpcCall("models.list", {});
  FakeSocket.instances[1]!.open();
  await next;
  expect(call).toHaveBeenCalledOnce();
});
test("disconnect fails a command without replay, while a new call reconnects", async () => {
  setup();
  call.mockRejectedValueOnce(new Error("Disconnected"));
  const failed = rpcCall("main.submit", prompt);
  FakeSocket.instances[0]!.open();
  await expect(failed).rejects.toThrow("Disconnected");
  FakeSocket.instances[0]!.close();
  const next = rpcCall("models.list", {});
  FakeSocket.instances[1]!.open();
  await next;
  expect(call.mock.calls.map(([operation]) => operation)).toEqual(["main.submit", "models.list"]);
});
test("explicit close terminates the resolved channel synchronously even when native close lingers", async () => {
  setup();
  call.mockImplementation(() =>
    channels[0]!.closed.then(() => {
      throw new Error("Closed");
    }),
  );
  const pending = rpcCall("main.submit", prompt);
  const socket = FakeSocket.instances[0]!;
  socket.open();
  await vi.waitFor(() => expect(call).toHaveBeenCalledOnce());
  vi.spyOn(socket, "close").mockImplementation(() => {
    socket.readyState = 2;
  });
  closeRpcTransport();
  expect(channels[0]!.close).toHaveBeenCalledOnce();
  expect(socket.readyState).toBe(2);
  await expect(pending).rejects.toThrow("Closed");
});
test("an unauthorized call discards its captured identity without replay; the next call reconnects", async () => {
  setup();
  const unauthorized = new RpcError("UNAUTHORIZED", "Expired cookie");
  call.mockRejectedValueOnce(unauthorized);
  const failed = rpcCall("main.submit", { ...prompt, text: "once" });
  FakeSocket.instances[0]!.open();
  await expect(failed).rejects.toBe(unauthorized);
  expect(channels[0]!.close).toHaveBeenCalledOnce();
  const recovered = rpcCall("models.list", {});
  FakeSocket.instances[1]!.open();
  await recovered;
  expect(call.mock.calls.map(([operation]) => operation)).toEqual(["main.submit", "models.list"]);
});

test("a late rejection from a closed generation does not discard its replacement", async () => {
  setup();
  let rejectOld!: (error: unknown) => void;
  call.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        rejectOld = reject;
      }),
  );
  const old = rpcCall("models.list", {});
  FakeSocket.instances[0]!.open();
  await vi.waitFor(() => expect(call).toHaveBeenCalledOnce());
  closeRpcTransport();
  const fresh = rpcCall("models.list", {});
  FakeSocket.instances[1]!.open();
  await fresh;
  rejectOld(new RpcError("UNAUTHORIZED", "Old cookie"));
  await expect(old).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  expect(channels[1]!.close).not.toHaveBeenCalled();
  await rpcCall("models.list", {});
  expect(FakeSocket.instances).toHaveLength(2);
});

test("successful HTTP relogin refreshes the socket upgrade cookie without a page reload", async () => {
  setup();
  document.cookie = "rpc-auth=old; Path=/";
  const first = rpcCall("models.list", {});
  FakeSocket.instances[0]!.open();
  await first;
  expect(FakeSocket.instances[0]!.cookie).toContain("rpc-auth=old");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      document.cookie = "rpc-auth=fresh; Path=/";
      return new Response(JSON.stringify({ ok: true }));
    }),
  );
  const { finishPasskeyLogin } = await import("./api");
  await finishPasskeyLogin("id", {} as Parameters<typeof finishPasskeyLogin>[1]);
  expect(channels[0]!.close).toHaveBeenCalledOnce();
  const next = rpcCall("models.list", {});
  expect(FakeSocket.instances[1]!.cookie).toContain("rpc-auth=fresh");
  FakeSocket.instances[1]!.open();
  await next;
  document.cookie = "rpc-auth=; Max-Age=0; Path=/";
});

test("passes raw bodies and AbortSignal through; pre-aborted calls never open a socket", async () => {
  setup();
  const signal = AbortSignal.abort();
  await expect(rpcCall("main.submit", prompt, { signal })).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(FakeSocket.instances).toHaveLength(0);
  const controller = new AbortController();
  const body = new ReadableStream<Uint8Array>();
  const result = rpcCall("main.submit", prompt, { body, signal: controller.signal });
  FakeSocket.instances[0]!.open();
  await result;
  expect(call.mock.calls[0]![2]).toEqual({ body, signal: controller.signal });
});
