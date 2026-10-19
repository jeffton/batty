import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { listenForPushForeground } from "./push-foreground";

function stream() {
  const source = new EventTarget();
  const close = listenForPushForeground(source as EventSource);
  const send = (name: string, data: object) =>
    source.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(data) }));
  send("push-client", { clientId: "live-stream" });
  return { send, close };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("push foreground client", () => {
  it("acks only while visible and focused, with the current stream and concrete challenge", () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetch);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const current = stream();
    const challenge = { clientId: "live-stream", challengeId: "delivery-1" };
    current.send("push-foreground", challenge);
    expect(fetch).not.toHaveBeenCalled();
    focus.mockReturnValue(true);
    current.send("push-foreground", challenge);
    expect(fetch).toHaveBeenCalledWith(
      "/api/push/foreground/ack",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify(challenge),
      }),
    );
    visibility.mockReturnValue("hidden");
    current.send("push-foreground", { ...challenge, challengeId: "delivery-2" });
    expect(fetch).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue("visible");
    current.send("push-foreground", { clientId: "old-stream", challengeId: "delivery-3" });
    current.close();
    current.send("push-foreground", { ...challenge, challengeId: "delivery-4" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("makes no periodic requests and treats ack timeout as normal push delivery", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn().mockRejectedValue(new DOMException("Timeout", "TimeoutError"));
      vi.stubGlobal("fetch", fetch);
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const error = vi.spyOn(console, "error");
      const current = stream();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fetch).not.toHaveBeenCalled();
      current.send("push-foreground", { clientId: "live-stream", challengeId: "delivery" });
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(error).not.toHaveBeenCalled();
      current.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
