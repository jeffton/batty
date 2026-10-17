<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import FullPopover from "@/client/components/FullPopover.vue";
import { withBaseUrl } from "@/client/lib/base-url";
import type {
  CloudBrowserState as BrowserState,
  CloudBrowserFrame as BrowserFrame,
} from "@/shared/cloud-browser";

type RemoteFrame = Omit<BrowserFrame, "image"> & { frameId: number };
type Point = { x: number; y: number };
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
};
const props = defineProps<{ popoverId: string; browserId: string; title: string }>();
const state = ref<BrowserState>();
const displayedFrame = ref<RemoteFrame>();
const image = ref<HTMLCanvasElement>();
let pendingFrame:
  | { frame: RemoteFrame; jpeg: Blob; socket: WebSocket; generation: number }
  | undefined;
let painting = false;
const hasFrame = ref(false);
const viewport = ref<HTMLElement>();
const editor = ref<HTMLInputElement | HTMLTextAreaElement>();
const address = ref("");
const addressInput = ref<HTMLInputElement>();
let addressWasFocused = false;
const text = ref("");
const error = ref("");
const connection = ref("Connecting…");
const reconnecting = ref(false);
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectAttempt = 0;
const ended = ref(false);
const open = ref(false);
const dismissedFocus = ref("");
const viewStyle = ref<Record<string, string>>({});
let stream: WebSocket | undefined;
let controller: AbortController | undefined;
let generation = 0;
let gesture: Gesture | undefined;
let resizeObserver: ResizeObserver | undefined;
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
let inputTimer: ReturnType<typeof setTimeout> | undefined;
const scrollPending: Array<
  Point & { deltaX: number; deltaY: number; pageId: string; revision: string }
> = [];
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
let queue: Promise<unknown> = Promise.resolve();
const endpoint = computed(() => `/api/cloud-browser/${encodeURIComponent(props.browserId)}`);
const ready = computed(() => !ended.value && !!state.value);
const frameReady = computed(
  () =>
    ready.value &&
    !reconnecting.value &&
    !!displayedFrame.value &&
    displayedFrame.value.pageId === state.value?.pageId &&
    displayedFrame.value.revision === state.value?.revision,
);
const focused = computed(() => state.value?.focused);
const editing = computed(() => focused.value && dismissedFocus.value !== focused.value.id);

async function request(
  path: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<BrowserState> {
  const response = await fetch(withBaseUrl(`${endpoint.value}/${path}`), {
    credentials: "include",
    ...init,
    signal,
  });
  if (!response.ok) {
    const body = (await response.json()) as { error: string };
    if (response.status === 404 || response.status === 410) {
      ended.value = true;
      stream?.close();
    }
    throw Object.assign(new Error(body.error), { statusCode: response.status });
  }
  return (await response.json()) as BrowserState;
}
function updateState(value: BrowserState): void {
  const pageChanged = state.value?.pageId !== value.pageId;
  if (state.value?.url !== value.url) address.value = value.url;
  if (state.value?.focused?.id !== value.focused?.id) {
    clearTimeout(inputTimer);
    inputTimer = undefined;
    text.value = value.focused?.value ?? "";
  } else if (document.activeElement !== editor.value && !inputTimer) {
    text.value = value.focused?.value ?? "";
  }
  state.value = value;
  if (pageChanged) scheduleResize();
}
function stopViewing(): void {
  generation++;
  stream?.close();
  stream = undefined;
  controller?.abort();
  controller = undefined;
  gesture = undefined;
  scrollPending.length = 0;
  scrollDirty = false;
  if (scrollFence) {
    clearTimeout(scrollFence.timer);
    scrollFence.reject(new Error("Browser view disconnected"));
    scrollFence = undefined;
  }
  pendingFrame = undefined;
  if (scrollAnimation !== undefined) cancelAnimationFrame(scrollAnimation);
  scrollAnimation = undefined;
  clearTimeout(inputTimer);
  inputTimer = undefined;
  clearTimeout(resizeTimer);
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
  if (reconnecting.value && open.value && !document.hidden) void startViewing();
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
        const length = new DataView(event.data).getUint32(0);
        const frame = JSON.parse(
          new TextDecoder().decode(new Uint8Array(event.data, 4, length)),
        ) as RemoteFrame;
        if (pendingFrame) acknowledge(pendingFrame.socket, pendingFrame.frame.frameId);
        pendingFrame = {
          frame,
          jpeg: new Blob([event.data.slice(4 + length)], { type: "image/jpeg" }),
          socket,
          generation: current,
        };
        void paintFrames();
        return;
      }
      const message = JSON.parse(event.data);
      if (message.event === "state") updateState(message.data);
      else if (message.event === "scroll-error") {
        error.value = message.data.error;
        if (scrollFence) failScrollFence(message.data.error);
      } else if (message.event === "scroll-drained" && message.data.requestId === scrollFence?.id) {
        clearTimeout(scrollFence.timer);
        scrollFence.resolve();
        scrollFence = undefined;
      } else if (message.event === "browser-error") {
        const failure = message.data as { error: string; retryable: boolean; statusCode?: number };
        if (failure.retryable) scheduleReconnect();
        else {
          stopViewing();
          reconnecting.value = false;
          displayedFrame.value = undefined;
          error.value = failure.error;
          ended.value = failure.statusCode === 410;
        }
      }
    };
  } catch (cause) {
    if (current !== generation || abort.signal.aborted) return;
    const status = (cause as { statusCode?: number }).statusCode;
    if (!status || status >= 500 || status === 429) scheduleReconnect();
    else {
      reconnecting.value = false;
      error.value = (cause as Error).message;
    }
  }
}
function acknowledge(socket: WebSocket, frameId: number): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ action: "ack", frameId }));
}
async function paintFrames(): Promise<void> {
  if (painting) return;
  painting = true;
  let decodingGeneration = generation;
  try {
    while (pendingFrame) {
      const next = pendingFrame;
      decodingGeneration = next.generation;
      pendingFrame = undefined;
      const bitmap = await createImageBitmap(next.jpeg);
      try {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        if (next.generation !== generation || next.socket !== stream) continue;
        if (
          next.frame.pageId === state.value?.pageId &&
          next.frame.revision === state.value?.revision
        ) {
          const canvas = image.value!;
          if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
          }
          canvas.getContext("2d", { alpha: false })!.drawImage(bitmap, 0, 0);
          displayedFrame.value = next.frame;
          hasFrame.value = true;
          canvas.dataset.frame = String(next.frame.frameId);
          reconnecting.value = false;
          reconnectAttempt = 0;
          connection.value = "Live";
        }
      } finally {
        bitmap.close();
        acknowledge(next.socket, next.frame.frameId);
      }
    }
  } catch (cause) {
    if (decodingGeneration === generation) {
      stopViewing();
      reconnecting.value = false;
      displayedFrame.value = undefined;
      error.value = `Browser image could not be decoded: ${(cause as Error).message}`;
    }
  } finally {
    painting = false;
    if (pendingFrame) void paintFrames();
  }
}
function onToggle(event: Event): void {
  open.value = (event as ToggleEvent).newState === "open";
  if (open.value) void startViewing();
  else stopViewing();
}
function resizeView(): void {
  const visual = window.visualViewport;
  viewStyle.value = {
    top: `calc(${visual?.offsetTop ?? 0}px + var(--safe-area-top) + 0.5rem)`,
    bottom: "auto",
    height: `calc(${visual?.height ?? window.innerHeight}px - var(--safe-area-top) - var(--safe-area-bottom) - 1rem)`,
  };
}
async function fitViewport(): Promise<void> {
  await nextTick();
  if (!ready.value) return;
  const rect = viewport.value?.getBoundingClientRect();
  if (!rect?.width || !rect.height) return;
  const width = Math.max(1, Math.min(10000, Math.round(rect.width)));
  const height = Math.max(1, Math.min(10000, Math.round(rect.height)));
  const mobile = navigator.maxTouchPoints > 0 && matchMedia("(pointer: coarse)").matches;
  const deviceScaleFactor = Math.min(3, Math.max(1, window.devicePixelRatio));
  // Keep keyboard-only height changes stable, but still fit rotation/device changes.
  if (
    (editing.value || document.activeElement?.tagName === "INPUT") &&
    state.value?.width === width &&
    state.value.mobile === mobile &&
    state.value.deviceScaleFactor === deviceScaleFactor
  )
    return;
  if (
    state.value?.width !== width ||
    state.value.height !== height ||
    state.value.mobile !== mobile ||
    state.value.deviceScaleFactor !== deviceScaleFactor
  )
    await control({ action: "viewport", width, height, mobile, deviceScaleFactor });
}
function scheduleResize(): void {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => void fitViewport(), 120);
}
function onVisibility(): void {
  if (document.hidden) stopViewing();
  else if (open.value && !ended.value) void startViewing();
}
function control(command: Record<string, unknown>): Promise<boolean> {
  const current = generation;
  const operation = async () => {
    if (current !== generation || !ready.value || !controller) return false;
    error.value = "";
    try {
      await drainScroll();
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
      return true;
    } catch (cause) {
      if (current === generation) error.value = (cause as Error).message;
      return false;
    }
  };
  const result = queue.then(operation);
  queue = result;
  return result;
}
function addressPointerDown(event: PointerEvent): void {
  addressWasFocused = document.activeElement === event.currentTarget;
}
function selectAddress(event: Event): void {
  (event.currentTarget as HTMLInputElement).select();
}
function navigate(): void {
  addressInput.value?.blur();
  editor.value?.blur();
  const value = address.value.trim();
  const url = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  void control({ action: "navigate", url });
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
  };
  image.value!.setPointerCapture(event.pointerId);
}
function pointerMove(event: PointerEvent): void {
  const start = gesture;
  if (!start || start.pointerId !== event.pointerId) return;
  if (!start.moved && Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) < 6)
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
    last &&
    last.pageId === frame.pageId &&
    last.revision === frame.revision &&
    last.x === anchor.x &&
    last.y === anchor.y
  ) {
    last.deltaX += deltaX;
    last.deltaY += deltaY;
  } else {
    if (scrollPending.length === 2) flushScroll();
    if (scrollPending.length === 2) {
      error.value = "Browser connection is busy; scroll target could not be queued.";
      return;
    }
    scrollPending.push({
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
  if (!scrollPending.length || stream?.readyState !== WebSocket.OPEN) return;
  // Never pile input into a stalled socket. Preserve totals in one coalesced slot.
  if (stream.bufferedAmount > 16384) {
    scrollAnimation = requestAnimationFrame(flushScroll);
    return;
  }
  while (scrollPending.length && stream.bufferedAmount <= 16384) {
    const pending = scrollPending[0]!;
    const deltaX = Math.max(-10000, Math.min(10000, pending.deltaX));
    const deltaY = Math.max(-10000, Math.min(10000, pending.deltaY));
    stream.send(JSON.stringify({ action: "scroll", ...pending, deltaX, deltaY }));
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
  flushScroll();
  if (scrollPending.length)
    throw new Error("Browser connection is busy; wait for scrolling to settle.");
  while (scrollDirty) {
    if (stream?.readyState !== WebSocket.OPEN) throw new Error("Browser is disconnected.");
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
    stream.send(JSON.stringify({ action: "flush", requestId: id }));
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
onMounted(() => {
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("resize", resizeView);
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  window.visualViewport?.addEventListener("resize", resizeView);
  window.visualViewport?.addEventListener("scroll", resizeView);
  resizeObserver = new ResizeObserver(scheduleResize);
  resizeObserver.observe(viewport.value!);
  resizeView();
});
onBeforeUnmount(() => {
  stopViewing();
  resizeObserver?.disconnect();
  document.removeEventListener("visibilitychange", onVisibility);
  window.removeEventListener("resize", resizeView);
  window.removeEventListener("online", onOnline);
  window.removeEventListener("offline", onOffline);
  window.visualViewport?.removeEventListener("resize", resizeView);
  window.visualViewport?.removeEventListener("scroll", resizeView);
});
</script>

<template>
  <FullPopover
    :popover-id="popoverId"
    :title="title"
    :style="viewStyle"
    class="browser-popover"
    @toggle="onToggle"
  >
    <template #heading>
      <form class="cloud-browser__address" @submit.prevent="navigate">
        <button
          type="button"
          :disabled="!ready"
          aria-label="Go back"
          @click="control({ action: 'back' })"
        >
          ←
        </button>
        <button
          type="button"
          :disabled="!ready"
          aria-label="Reload page"
          @click="control({ action: 'reload' })"
        >
          ↻
        </button>
        <input
          ref="addressInput"
          v-model="address"
          aria-label="Browser address"
          @focus="selectAddress"
          @pointerdown="addressPointerDown"
          @click="!addressWasFocused && selectAddress($event)"
          type="text"
          inputmode="url"
          enterkeyhint="go"
          autocapitalize="off"
          :spellcheck="false"
          placeholder="Address"
        />
      </form>
    </template>
    <div class="cloud-browser">
      <div v-if="error" class="cloud-browser__error" role="alert">
        {{ error }} <button v-if="!ended" type="button" @click="startViewing">Reconnect</button>
      </div>
      <div v-if="reconnecting" class="cloud-browser__connection" role="status">Reconnecting…</div>
      <div ref="viewport" class="cloud-browser__viewport">
        <canvas
          v-show="hasFrame"
          ref="image"
          class="cloud-browser__image"
          :data-revision="displayedFrame?.revision"
          role="img"
          aria-label="Live browser page. Tap to click; swipe to scroll."
          @pointerdown.prevent="pointerDown"
          @pointermove.prevent="pointerMove"
          @pointerup.prevent="pointerUp"
          @pointercancel="gesture = undefined"
          @lostpointercapture="gesture = undefined"
          @wheel.prevent="wheel"
          @contextmenu.prevent
        />
        <p v-if="!hasFrame">{{ ended ? "Session unavailable" : connection }}</p>
      </div>
      <div v-if="editing" class="cloud-browser__editor">
        <textarea
          v-if="focused?.multiline"
          ref="editor"
          v-model="text"
          rows="2"
          aria-label="Focused browser field"
          @input="scheduleInput"
          @compositionstart="beginComposition"
          @compositionend="scheduleInput"
        />
        <input
          v-else
          ref="editor"
          v-model="text"
          :type="focused?.type === 'number' ? 'text' : focused?.type"
          :inputmode="focused?.type === 'number' ? 'decimal' : undefined"
          aria-label="Focused browser field"
          placeholder="Type here…"
          enterkeyhint="go"
          @input="scheduleInput"
          @compositionstart="beginComposition"
          @compositionend="scheduleInput"
          @keydown.enter="submitInput"
        />
        <button type="button" @click="dismissInput">Done</button>
      </div>
    </div>
  </FullPopover>
</template>

<style scoped>
.browser-popover :deep(.full-popover__header) {
  padding: 0.4rem;
  gap: 0.4rem;
}
.cloud-browser {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  color: var(--color-text);
  background: var(--color-bg-panel);
}
.cloud-browser__address,
.cloud-browser__editor {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  min-width: 0;
}
.cloud-browser__address button,
.cloud-browser__address input,
.cloud-browser button,
.cloud-browser input,
.cloud-browser textarea {
  min-height: 2.4rem;
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--color-border-soft);
  border-radius: 0.45rem;
  background: var(--color-bg-panel);
  color: var(--color-text);
  font: inherit;
  font-size: 1rem;
}
.cloud-browser__address input,
.cloud-browser__address button {
  height: var(--button-size);
  min-height: var(--button-size);
}
.cloud-browser__address input,
.cloud-browser__editor input,
.cloud-browser__editor textarea {
  flex: 1;
  min-width: 0;
  width: 0;
}
.cloud-browser__address button,
.cloud-browser button {
  flex-shrink: 0;
  cursor: pointer;
}
.cloud-browser__address button:disabled {
  opacity: 0.5;
}
.cloud-browser__error,
.cloud-browser__connection {
  flex-shrink: 0;
  padding: 0.5rem;
  overflow-wrap: anywhere;
}
.cloud-browser__connection {
  position: absolute;
  z-index: 1;
  top: 0.4rem;
  right: 0.4rem;
  border-radius: 0.4rem;
  background: var(--color-bg-panel);
  pointer-events: none;
}
.cloud-browser__viewport {
  display: flex;
  align-items: flex-start;
  justify-content: center;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  overscroll-behavior: none;
  touch-action: none;
}
.cloud-browser__viewport p {
  padding: 1rem;
}
.cloud-browser__image {
  display: block;
  width: auto;
  height: auto;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  touch-action: none;
  user-select: none;
}
.cloud-browser__editor {
  flex-shrink: 0;
  padding: 0.4rem;
  border-top: 1px solid var(--color-border-soft);
}
</style>
