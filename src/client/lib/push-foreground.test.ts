import { afterEach, expect, it, vi } from "vite-plus/test";
import { createPushForegroundHandler } from "./push-foreground";
import { rpcCall } from "./rpc";
vi.mock("./rpc", () => ({ rpcCall: vi.fn() }));
afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it("acks only its visible focused stream's concrete challenge and stops after close", () => {
  vi.mocked(rpcCall).mockResolvedValue({ value: {} });
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
  const current = createPushForegroundHandler();
  current.onEvent({ type: "push-client", clientId: "live" });
  const challenge = {
    type: "push-foreground",
    clientId: "live",
    challengeId: "delivery-1",
  } as const;
  current.onEvent(challenge);
  expect(rpcCall).not.toHaveBeenCalled();
  focus.mockReturnValue(true);
  current.onEvent(challenge);
  expect(rpcCall).toHaveBeenCalledWith(
    "push.ack",
    { clientId: "live", challengeId: "delivery-1" },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  visibility.mockReturnValue("hidden");
  current.onEvent(challenge);
  visibility.mockReturnValue("visible");
  current.onEvent({ ...challenge, clientId: "old" });
  current.close();
  current.onEvent(challenge);
  expect(rpcCall).toHaveBeenCalledOnce();
});
it("does not poll and treats acknowledgement timeout as ordinary push delivery", async () => {
  vi.useFakeTimers();
  vi.mocked(rpcCall).mockRejectedValue(new DOMException("Timeout", "TimeoutError"));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const error = vi.spyOn(console, "error");
  const current = createPushForegroundHandler();
  current.onEvent({ type: "push-client", clientId: "live" });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(rpcCall).not.toHaveBeenCalled();
  current.onEvent({ type: "push-foreground", clientId: "live", challengeId: "delivery" });
  await vi.advanceTimersByTimeAsync(1000);
  expect(rpcCall).toHaveBeenCalledOnce();
  expect(error).not.toHaveBeenCalled();
  current.close();
});
