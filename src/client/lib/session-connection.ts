import type { ServerEvent } from "@/shared/types";

type ConnectionOptions = {
  path: () => string;
  onConnecting: () => void;
  onOpen?: () => void;
  onEvent: (event: ServerEvent) => void;
  onError: () => void;
  onWatchdog?: () => void;
};

/** Shared SSE lifecycle. Every reconnect resolves its cursor from current state. */
export function createSessionConnection(options: ConnectionOptions) {
  let source: EventSource | undefined;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let lastActivity = 0;
  let lastWatchdog = 0;
  let active = false;

  function stopSource() {
    clearTimeout(retry);
    clearInterval(watchdog);
    retry = undefined;
    watchdog = undefined;
    source?.close();
    source = undefined;
  }

  function connect() {
    stopSource();
    options.onConnecting();
    const current = new EventSource(options.path());
    source = current;
    lastActivity = Date.now();
    lastWatchdog = lastActivity;
    const touch = () => {
      if (source === current) lastActivity = Date.now();
    };
    current.addEventListener("heartbeat", touch);
    watchdog = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      recover();
      if (Date.now() - lastWatchdog >= 15_000) {
        lastWatchdog = Date.now();
        options.onWatchdog?.();
      }
    }, 5000);
    current.onopen = () => {
      if (source !== current) return;
      clearTimeout(retry);
      retry = undefined;
      touch();
      options.onOpen?.();
    };
    current.onmessage = (message) => {
      if (source !== current) return;
      touch();
      options.onEvent(JSON.parse(message.data) as ServerEvent);
    };
    current.onerror = () => {
      if (source !== current) return;
      // Own retries instead of racing EventSource's automatic reconnect.
      stopSource();
      options.onError();
      retry = setTimeout(recover, 2000);
    };
  }

  function recover() {
    if (!active || !navigator.onLine) return;
    if (source && Date.now() - lastActivity < 15_000) return;
    connect();
  }

  function offline() {
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
    document.removeEventListener("visibilitychange", visible);
  }

  return { open, recover, close };
}
