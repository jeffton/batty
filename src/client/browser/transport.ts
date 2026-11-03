import { computed, ref } from "vue";
import { withBaseUrl } from "@/client/lib/base-url";
import type { CloudBrowserState as BrowserState } from "@/shared/cloud-browser";
import { useBrowserFrames } from "./frames";
import { useBrowserInput } from "./input";

// Owns one viewing generation: HTTP controls, socket, reconnects and their cancellation.
export function useBrowserTransport(
  browserId: () => string,
  {
    onState,
    onStop,
    fitViewport,
  }: {
    onState: (state: BrowserState, previous: BrowserState | undefined) => void;
    onStop: () => void;
    fitViewport: () => Promise<void>;
  },
) {
  const state = ref<BrowserState>();
  const availablePages = ref<BrowserState["pages"]>([]);
  const error = ref("");
  const connection = ref("Connecting…");
  const reconnecting = ref(false);
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectAttempt = 0;
  const ended = ref(false);
  const open = ref(false);
  let stream: WebSocket | undefined;
  let controller: AbortController | undefined;
  let generation = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const endpoint = computed(() => `/api/cloud-browser/${encodeURIComponent(browserId())}`);
  const ready = computed(() => !ended.value && !!state.value);
  const frameReady = computed(
    () =>
      ready.value &&
      !reconnecting.value &&
      !!displayedFrame.value &&
      displayedFrame.value.pageId === state.value?.pageId &&
      displayedFrame.value.revision === state.value?.revision,
  );
  const frames = useBrowserFrames({
    getGeneration: () => generation,
    getSocket: () => stream,
    getState: () => state.value,
    onLive: () => {
      reconnecting.value = false;
      reconnectAttempt = 0;
      connection.value = "Live";
    },
    onDecodeError: (cause) => {
      stopViewing();
      reconnecting.value = false;
      displayedFrame.value = undefined;
      error.value = `Browser image could not be decoded: ${cause.message}`;
    },
  });
  const { image, displayedFrame, hasFrame } = frames;
  const input = useBrowserInput({
    state,
    image,
    displayedFrame,
    frameReady,
    error,
    getSocket: () => stream,
    control,
    scheduleReconnect,
  });
  async function request(
    path: string,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<BrowserState> {
    const response = await fetch(withBaseUrl(`${endpoint.value}/${path}`), {
      credentials: "include",
      cache: "no-store",
      ...init,
      signal,
    });
    if (!response.ok) {
      const body = (await response.json()) as { error: string; pages?: BrowserState["pages"] };
      throw Object.assign(new Error(body.error), {
        statusCode: response.status,
        pages: body.pages,
      });
    }
    return (await response.json()) as BrowserState;
  }
  function updateState(value: BrowserState): void {
    const previous = state.value;
    input.updateFocus(value);
    state.value = value;
    availablePages.value = value.pages;
    onState(value, previous);
  }
  function selectionClosed(pages: BrowserState["pages"]): void {
    availablePages.value = pages;
    state.value = undefined;
    hasFrame.value = false;
    displayedFrame.value = undefined;
    // Do not replay an interrupted command on another tab. Reconcile state in
    // a fresh generation, then reconnect the viewer to the surviving selection.
    scheduleReconnect();
  }
  function showFailure(
    cause: Error & { statusCode?: number; pages?: BrowserState["pages"] },
  ): void {
    if (cause.statusCode === 409 && cause.pages) {
      selectionClosed(cause.pages);
      return;
    } else if (cause.statusCode === 404 || cause.statusCode === 410) {
      stopViewing();
      ended.value = true;
      reconnecting.value = false;
    }
    error.value = cause.message;
  }
  function stopViewing(): void {
    generation++;
    stream?.close();
    stream = undefined;
    controller?.abort();
    controller = undefined;
    queue = Promise.resolve();
    input.stop();
    frames.stop();
    onStop();
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  function scheduleReconnect(): void {
    stopViewing();
    if (!open.value || document.hidden || ended.value) return;
    reconnecting.value = true;
    connection.value = "Reconnecting…";
    const delay = Math.min(1000 * 2 ** reconnectAttempt++, 15000);
    reconnectTimer = setTimeout(() => void startViewing(), delay);
  }
  function onOffline(): void {
    if (open.value && !ended.value) scheduleReconnect();
  }
  function onOnline(): void {
    if (open.value && !ended.value && !document.hidden) void startViewing();
  }
  async function startViewing(): Promise<void> {
    stopViewing();
    if (!open.value || document.hidden) return;
    const current = generation;
    const abort = new AbortController();
    controller = abort;
    ended.value = false;
    error.value = "";
    connection.value = "Connecting…";
    if (!reconnecting.value) {
      hasFrame.value = false;
      displayedFrame.value = undefined;
      state.value = undefined;
    }
    try {
      const initial = await request("state", {}, abort.signal);
      if (current !== generation) return;
      updateState(initial);
      await fitViewport();
      if (current !== generation) return;
      connectStream(current);
    } catch (cause) {
      if (current !== generation || abort.signal.aborted) return;
      const status = (cause as { statusCode?: number }).statusCode;
      if (!status || (status >= 500 && status !== 504) || status === 429) scheduleReconnect();
      else {
        reconnecting.value = false;
        showFailure(cause as Error);
      }
    }
  }
  function connectStream(current: number): void {
    const url = new URL(withBaseUrl(`${endpoint.value}/socket`), window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    stream = socket;
    socket.onclose = () => {
      if (current === generation) scheduleReconnect();
    };
    socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
      if (current !== generation) return;
      if (typeof event.data !== "string") {
        frames.receive(event.data, socket, current);
        return;
      }
      const message = JSON.parse(event.data);
      if (message.event === "state") updateState(message.data);
      else if (message.event === "scroll-error") input.scrollError(message.data.error);
      else if (message.event === "scroll-drained") input.scrollDrained(message.data.requestId);
      else if (message.event === "browser-error") {
        const failure = message.data as {
          error: string;
          retryable: boolean;
          statusCode?: number;
          pages?: BrowserState["pages"];
        };
        if (failure.statusCode === 409 && failure.pages) {
          selectionClosed(failure.pages);
        } else if (failure.retryable) scheduleReconnect();
        else {
          stopViewing();
          reconnecting.value = false;
          displayedFrame.value = undefined;
          error.value = failure.error;
          ended.value = failure.statusCode === 410;
        }
      }
    };
  }
  function onToggle(event: Event): void {
    open.value = (event as ToggleEvent).newState === "open";
    if (open.value) void startViewing();
    else stopViewing();
  }
  function onVisibility(): void {
    if (document.hidden) stopViewing();
    else if (open.value && !ended.value) void startViewing();
  }
  function onPageShow(event: PageTransitionEvent): void {
    if (event.persisted && open.value && !ended.value) void startViewing();
  }
  function control(command: Record<string, unknown>): Promise<boolean> {
    const recovery = command.action === "new-page" || command.action === "switch";
    if (recovery && open.value && !ended.value && (!ready.value || !controller || !stream)) {
      stopViewing();
      controller = new AbortController();
    }
    const current = generation;
    const operation = async () => {
      if (current !== generation || !open.value || ended.value || (!ready.value && !recovery))
        return false;
      if (!controller) {
        if (!recovery) return false;
        controller = new AbortController();
      }
      error.value = "";
      try {
        await input.drainScroll();
        if (current !== generation || !controller) return false;
        const value = await request(
          "control",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(command),
          },
          controller.signal,
        );
        if (current !== generation) return false;
        updateState(value);
        if (recovery && !stream) connectStream(current);
        return true;
      } catch (cause) {
        if (current === generation) {
          const status = (cause as { statusCode?: number }).statusCode;
          if (!status || (status >= 500 && status !== 504) || status === 429) scheduleReconnect();
          else showFailure(cause as Error);
        }
        return false;
      }
    };
    const result = queue.then(operation);
    queue = result;
    return result;
  }

  return {
    state,
    availablePages,
    ready,
    error,
    connection,
    reconnecting,
    ended,
    frames,
    input,
    control,
    startViewing,
    stopViewing,
    onToggle,
    onVisibility,
    onPageShow,
    onOnline,
    onOffline,
  };
}
