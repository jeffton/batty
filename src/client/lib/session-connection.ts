import type { ServerEvent } from "@/shared/types";
import type { OwnerInputs, OwnerSessionEvent } from "@/shared/owner-api";
import { rpcCall, closeRpcTransport } from "./rpc";
import { recordErrorLifecycle } from "./browser-errors";
import { createPushForegroundHandler } from "./push-foreground";

type ConnectionOptions = {
  operation: "session.watch";
  input: () => OwnerInputs["session.watch"];
  onConnecting: () => void;
  onOpen?: () => void;
  onEvent: (event: ServerEvent) => void;
  onError: () => void;
  onWatchdog?: () => void;
};
type Subscription = {
  controller: AbortController;
  reader?: ReadableStreamDefaultReader<OwnerSessionEvent>;
  connecting: boolean;
  foreground: ReturnType<typeof createPushForegroundHandler>;
};

/** Reconnect resolves its input/cursor from current state; commands are never replayed. */
export function createSessionConnection(options: ConnectionOptions) {
  let source: Subscription | undefined;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let startedAt = 0;
  let lastWatchdog = 0;
  let lastTick = 0;
  let suspended = false;
  let active = false;

  function stopSource() {
    clearTimeout(retry);
    clearInterval(watchdog);
    retry = undefined;
    watchdog = undefined;
    const previous = source;
    source = undefined;
    previous?.foreground.close();
    previous?.controller.abort();
    void previous?.reader?.cancel().catch(() => {});
  }

  async function subscribe(current: Subscription): Promise<void> {
    let reader: ReadableStreamDefaultReader<OwnerSessionEvent> | undefined;
    try {
      const reply = await rpcCall(options.operation, options.input(), {
        signal: current.controller.signal,
      });
      if (source !== current) {
        await reply.events?.cancel();
        return;
      }
      reader = reply.events!.getReader();
      current.reader = reader;
      current.connecting = false;
      options.onOpen?.();
      while (source === current) {
        const item = await reader.read();
        if (source !== current) return;
        if (item.done) throw new Error("Session subscription disconnected");
        const event = item.value;
        current.foreground.onEvent(event);
        if (
          event.type !== "heartbeat" &&
          event.type !== "push-client" &&
          event.type !== "push-foreground"
        )
          options.onEvent(event);
      }
    } catch {
      if (source !== current) return;
      stopSource();
      options.onError();
      retry = setTimeout(recover, 2000);
    } finally {
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
    }
  }

  function connect() {
    stopSource();
    recordErrorLifecycle("reconnect");
    options.onConnecting();
    const current: Subscription = {
      controller: new AbortController(),
      connecting: true,
      foreground: createPushForegroundHandler(),
    };
    source = current;
    startedAt = Date.now();
    lastWatchdog = startedAt;
    lastTick = startedAt;
    suspended = false;
    watchdog = setInterval(() => {
      const now = Date.now();
      suspended ||= now < lastTick || now - lastTick > 10_000;
      lastTick = now;
      if (document.visibilityState === "hidden") return;
      recover();
      if (Date.now() - lastWatchdog >= 15_000) {
        lastWatchdog = Date.now();
        options.onWatchdog?.();
      }
    }, 5000);
    void subscribe(current);
  }

  function recover() {
    if (!active || !navigator.onLine) return;
    const age = Date.now() - startedAt;
    // Session events can be idle indefinitely; RpcChannel owns socket liveness.
    if (source && !suspended && (!source.connecting || (age >= 0 && age < 5000))) return;
    // A new subscription alone cannot recover a half-open socket after standby.
    if (source) closeRpcTransport();
    connect();
  }
  function offline() {
    closeRpcTransport();
    stopSource();
    options.onError();
  }
  function visible() {
    if (document.visibilityState !== "hidden") recover();
  }
  function open() {
    if (!active) {
      active = true;
      window.addEventListener("online", recover);
      window.addEventListener("offline", offline);
      window.addEventListener("pageshow", recover);
      window.addEventListener("focus", recover);
      document.addEventListener("resume", visible);
      document.addEventListener("visibilitychange", visible);
    }
    if (navigator.onLine) recover();
    else offline();
  }
  function close() {
    active = false;
    stopSource();
    window.removeEventListener("online", recover);
    window.removeEventListener("offline", offline);
    window.removeEventListener("pageshow", recover);
    window.removeEventListener("focus", recover);
    document.removeEventListener("resume", visible);
    document.removeEventListener("visibilitychange", visible);
  }
  return { open, recover, close };
}
