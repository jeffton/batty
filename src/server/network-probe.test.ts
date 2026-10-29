import { EventEmitter } from "node:events";
import { afterEach, expect, test, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ tcp: false }));
vi.mock("node:net", () => ({
  connect: () => {
    const socket = new EventEmitter() as EventEmitter & { destroy: () => void };
    socket.destroy = () => {};
    queueMicrotask(() => socket.emit(state.tcp ? "connect" : "error", new Error("offline")));
    return socket;
  },
}));
import { networkAvailable } from "./network-recovery";

afterEach(() => {
  vi.unstubAllGlobals();
  state.tcp = false;
});
const transport = (code: string) =>
  new TypeError("fetch failed", {
    cause: Object.assign(new Error("network failure"), { code }),
  });

test("all independent transport probes failing confirms offline", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(transport("ENETUNREACH")));
  expect(await networkAvailable()).toBe(false);
});

test("any HTTP response, including an auth error, proves connectivity", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockRejectedValueOnce(transport("ECONNREFUSED"))
      .mockResolvedValueOnce(new Response(null, { status: 401 })),
  );
  expect(await networkAvailable()).toBe(true);
});

test("broken DNS with a functioning IP connection is not classified as offline", async () => {
  state.tcp = true;
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(transport("ENOTFOUND")));
  expect(await networkAvailable()).toBe(true);
});

test("certificate errors are not hidden behind indefinite network waiting", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(transport("CERT_HAS_EXPIRED")));
  expect(await networkAvailable()).toBe(true);
});

test("an aborted probe rejects rather than claiming the host is offline", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(transport("ENETUNREACH")));
  await expect(networkAvailable(AbortSignal.abort())).rejects.toThrow();
});
