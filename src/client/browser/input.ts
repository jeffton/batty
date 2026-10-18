import { computed, ref, type Ref } from "vue";
import type { CloudBrowserState, CloudBrowserTouch } from "@/shared/cloud-browser";
import type { Point, RemoteFrame } from "./types";

type Gesture = {
  pointerId: number;
  clientX: number;
  clientY: number;
  lastX: number;
  lastY: number;
  moved: boolean;
  frame: RemoteFrame;
  rect: DOMRect;
  anchor: Point;
  nativeTouch: boolean;
  startedAt: number;
};
type ScrollInput = Point & {
  action: "scroll";
  deltaX: number;
  deltaY: number;
  pageId: string;
  revision: string;
};

export function useBrowserInput({
  state,
  image,
  displayedFrame,
  frameReady,
  error,
  getSocket,
  control,
  scheduleReconnect,
}: {
  state: Ref<CloudBrowserState | undefined>;
  image: Ref<HTMLCanvasElement | undefined>;
  displayedFrame: Ref<RemoteFrame | undefined>;
  frameReady: Readonly<Ref<boolean>>;
  error: Ref<string>;
  getSocket: () => WebSocket | undefined;
  control: (command: Record<string, unknown>) => Promise<boolean>;
  scheduleReconnect: () => void;
}) {
  const editor = ref<HTMLInputElement | HTMLTextAreaElement>();
  const text = ref("");
  const dismissedFocus = ref("");
  const focused = computed(() => state.value?.focused);
  const editing = computed(() => focused.value && dismissedFocus.value !== focused.value.id);
  let gesture: Gesture | undefined;
  let inputTimer: ReturnType<typeof setTimeout> | undefined;
  const scrollPending: Array<ScrollInput | CloudBrowserTouch> = [];
  let scrollDirty = false;
  let nextFenceId = 1;
  let scrollFence:
    | {
        id: number;
        promise: Promise<void>;
        resolve: () => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  let scrollAnimation: number | undefined;

  function updateFocus(value: CloudBrowserState): void {
    if (
      gesture &&
      (gesture.frame.revision !== value.revision || gesture.frame.pageId !== value.pageId)
    )
      cancelGesture();
    if (state.value?.focused?.id !== value.focused?.id) {
      clearTimeout(inputTimer);
      inputTimer = undefined;
      text.value = value.focused?.value ?? "";
    } else if (document.activeElement !== editor.value && !inputTimer) {
      text.value = value.focused?.value ?? "";
    }
  }
  function cancelGesture(): void {
    const start = gesture;
    gesture = undefined;
    if (start?.nativeTouch) addTouch(start, "cancel", start.lastX, start.lastY);
  }
  function addTouch(
    start: Gesture,
    phase: CloudBrowserTouch["phase"],
    clientX: number,
    clientY: number,
    timestamp = performance.now(),
  ): void {
    const command: CloudBrowserTouch = {
      action: "touch",
      phase,
      ...point(clientX, clientY, start.rect, start.frame),
      pageId: start.frame.pageId,
      revision: start.frame.revision,
      // Preserve the finger's clock when the viewer main thread is busy. Handler
      // execution time can turn a fast release into a pause and suppress inertia.
      elapsedMs: timestamp - start.startedAt,
    };
    const last = scrollPending.at(-1);
    if (phase === "move" && last?.action === "touch" && last.phase === "move")
      scrollPending[scrollPending.length - 1] = command;
    else {
      if (scrollPending.length >= 64) {
        error.value = "Browser touch connection is busy.";
        scheduleReconnect();
        return;
      }
      scrollPending.push(command);
    }
    flushScroll();
  }
  function stop(): void {
    gesture = undefined;
    scrollPending.length = 0;
    scrollDirty = false;
    if (scrollFence) {
      clearTimeout(scrollFence.timer);
      scrollFence.reject(new Error("Browser view disconnected"));
      scrollFence = undefined;
    }
    if (scrollAnimation !== undefined) cancelAnimationFrame(scrollAnimation);
    scrollAnimation = undefined;
    clearTimeout(inputTimer);
    inputTimer = undefined;
    text.value = "";
  }
  function scrollError(message: string): void {
    error.value = message;
    if (scrollFence) failScrollFence(message);
  }
  function scrollDrained(requestId: number): void {
    if (requestId === scrollFence?.id) {
      clearTimeout(scrollFence.timer);
      scrollFence.resolve();
      scrollFence = undefined;
    }
  }
  function point(clientX: number, clientY: number, rect: DOMRect, frame: RemoteFrame): Point {
    return {
      x: Math.max(
        0,
        Math.min(frame.width - 1, Math.round(((clientX - rect.left) * frame.width) / rect.width)),
      ),
      y: Math.max(
        0,
        Math.min(frame.height - 1, Math.round(((clientY - rect.top) * frame.height) / rect.height)),
      ),
    };
  }
  function pointerDown(event: PointerEvent): void {
    if (!frameReady.value || event.button !== 0 || gesture) return;
    const rect = image.value!.getBoundingClientRect();
    const frame = displayedFrame.value!;
    gesture = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      moved: false,
      rect,
      frame,
      anchor: point(event.clientX, event.clientY, rect, frame),
      nativeTouch: event.pointerType === "touch" && !!state.value?.mobile,
      startedAt: event.timeStamp,
    };
    image.value!.setPointerCapture(event.pointerId);
    if (gesture.nativeTouch) {
      dismissedFocus.value = "";
      addTouch(gesture, "start", event.clientX, event.clientY, event.timeStamp);
    }
  }
  function pointerMove(event: PointerEvent): void {
    const start = gesture;
    if (!start || start.pointerId !== event.pointerId) return;
    if (start.nativeTouch) {
      if (start.lastX !== event.clientX || start.lastY !== event.clientY)
        addTouch(start, "move", event.clientX, event.clientY, event.timeStamp);
      start.lastX = event.clientX;
      start.lastY = event.clientY;
      return;
    }
    if (
      !start.moved &&
      Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) < 6
    )
      return;
    start.moved = true;
    addScroll(
      start.anchor,
      start.frame,
      ((start.lastX - event.clientX) * start.frame.width) / start.rect.width,
      ((start.lastY - event.clientY) * start.frame.height) / start.rect.height,
    );
    start.lastX = event.clientX;
    start.lastY = event.clientY;
  }
  function pointerUp(event: PointerEvent): void {
    const start = gesture;
    if (!start || start.pointerId !== event.pointerId) return;
    pointerMove(event);
    gesture = undefined;
    if (start.nativeTouch) {
      addTouch(start, "end", event.clientX, event.clientY, event.timeStamp);
      return;
    }
    if (!start.moved) {
      dismissedFocus.value = "";
      void control({
        action: "click",
        ...start.anchor,
        pageId: start.frame.pageId,
        revision: start.frame.revision,
      });
    }
  }
  function addScroll(anchor: Point, frame: RemoteFrame, deltaX: number, deltaY: number): void {
    const last = scrollPending.at(-1);
    if (
      last?.action === "scroll" &&
      last.pageId === frame.pageId &&
      last.revision === frame.revision &&
      last.x === anchor.x &&
      last.y === anchor.y
    ) {
      last.deltaX += deltaX;
      last.deltaY += deltaY;
    } else {
      if (scrollPending.length >= 2) flushScroll();
      if (scrollPending.length >= 2) {
        error.value = "Browser connection is busy; scroll target could not be queued.";
        return;
      }
      scrollPending.push({
        action: "scroll",
        ...anchor,
        pageId: frame.pageId,
        revision: frame.revision,
        deltaX,
        deltaY,
      });
    }
    // Native pointer events are already display-coalesced. Send immediately rather
    // than adding another animation-frame of latency; stalled transports coalesce below.
    flushScroll();
  }
  function flushScroll(): void {
    if (scrollAnimation !== undefined) cancelAnimationFrame(scrollAnimation);
    scrollAnimation = undefined;
    const socket = getSocket();
    if (!scrollPending.length || socket?.readyState !== WebSocket.OPEN) return;
    // Never pile input into a stalled socket. Preserve totals in one coalesced slot.
    if (socket.bufferedAmount > 16384) {
      scrollAnimation = requestAnimationFrame(flushScroll);
      return;
    }
    while (scrollPending.length && socket.bufferedAmount <= 16384) {
      const pending = scrollPending[0]!;
      if (pending.action === "touch") {
        socket.send(JSON.stringify(pending));
        scrollPending.shift();
        scrollDirty = true;
        continue;
      }
      const deltaX = Math.max(-10000, Math.min(10000, pending.deltaX));
      const deltaY = Math.max(-10000, Math.min(10000, pending.deltaY));
      socket.send(JSON.stringify({ ...pending, deltaX, deltaY }));
      scrollDirty = true;
      pending.deltaX -= deltaX;
      pending.deltaY -= deltaY;
      if (!pending.deltaX && !pending.deltaY) scrollPending.shift();
    }
    if (scrollPending.length) scrollAnimation = requestAnimationFrame(flushScroll);
  }
  function failScrollFence(message: string): void {
    const fence = scrollFence;
    if (!fence) return;
    clearTimeout(fence.timer);
    scrollFence = undefined;
    fence.reject(new Error(message));
    error.value = message;
    // A failed fence cannot authorize another HTTP action on this connection.
    scheduleReconnect();
  }
  async function drainScroll(): Promise<void> {
    cancelGesture();
    flushScroll();
    if (scrollPending.length)
      throw new Error("Browser connection is busy; wait for scrolling to settle.");
    while (scrollDirty) {
      const socket = getSocket();
      if (socket?.readyState !== WebSocket.OPEN) throw new Error("Browser is disconnected.");
      scrollDirty = false;
      const id = nextFenceId++;
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<void>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      const timer = setTimeout(() => {
        if (scrollFence?.id === id) {
          failScrollFence("Browser scrolling did not settle.");
        }
      }, 8000);
      scrollFence = { id, promise, resolve, reject, timer };
      socket.send(JSON.stringify({ action: "flush", requestId: id }));
      await promise;
    }
  }
  function wheel(event: WheelEvent): void {
    if (!frameReady.value) return;
    const frame = displayedFrame.value!;
    const rect = image.value!.getBoundingClientRect();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
    addScroll(
      point(event.clientX, event.clientY, rect, frame),
      frame,
      (event.deltaX * unit * frame.width) / rect.width,
      (event.deltaY * unit * frame.height) / rect.height,
    );
  }
  function beginComposition(): void {
    clearTimeout(inputTimer);
    inputTimer = undefined;
  }
  function scheduleInput(event: Event): void {
    clearTimeout(inputTimer);
    inputTimer = undefined;
    if ((event as InputEvent).isComposing) return;
    inputTimer = setTimeout(() => void sendText(), 50);
  }
  async function sendText(): Promise<boolean> {
    clearTimeout(inputTimer);
    inputTimer = undefined;
    const frame = displayedFrame.value;
    const focus = focused.value;
    if (!frameReady.value || !frame || !focus) return false;
    return control({
      action: "fill-focused",
      value: text.value,
      focusId: focus.id,
      pageId: frame.pageId,
      revision: frame.revision,
    });
  }
  async function submitInput(event: KeyboardEvent): Promise<void> {
    if (event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    const frame = displayedFrame.value;
    const focusId = focused.value?.id;
    if (!(await sendText())) return;
    if (frameReady.value && frame && focusId && focused.value?.id === focusId)
      await control({
        action: "key",
        key: "Enter",
        focusId,
        pageId: frame.pageId,
        revision: frame.revision,
      });
  }
  function dismissInput(): void {
    void sendText();
    dismissedFocus.value = focused.value?.id ?? "";
    editor.value?.blur();
  }

  return {
    editor,
    text,
    focused,
    editing,
    updateFocus,
    stop,
    scrollError,
    scrollDrained,
    drainScroll,
    pointerDown,
    pointerMove,
    pointerUp,
    cancelGesture,
    wheel,
    beginComposition,
    scheduleInput,
    submitInput,
    dismissInput,
  };
}
