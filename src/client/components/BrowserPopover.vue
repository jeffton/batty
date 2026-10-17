<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import FullPopover from "@/client/components/FullPopover.vue";
import { withBaseUrl } from "@/client/lib/base-url";
import type {
  CloudBrowserState as BrowserState,
  CloudBrowserFrame as BrowserFrame,
} from "@/shared/cloud-browser";

type Point = { x: number; y: number };
type Gesture = {
  pointerId: number;
  clientX: number;
  clientY: number;
  lastX: number;
  lastY: number;
  moved: boolean;
  frame: BrowserFrame;
  rect: DOMRect;
  anchor: Point;
};
const props = defineProps<{ popoverId: string; browserId: string; title: string }>();
const state = ref<BrowserState>();
const incomingFrame = ref<BrowserFrame>();
const displayedFrame = ref<BrowserFrame>();
const image = ref<HTMLImageElement>();
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
let stream: EventSource | undefined;
let controller: AbortController | undefined;
let generation = 0;
let gesture: Gesture | undefined;
let resizeObserver: ResizeObserver | undefined;
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
let inputTimer: ReturnType<typeof setTimeout> | undefined;
let scrollPending:
  | (Point & { deltaX: number; deltaY: number; pageId: string; revision: string })
  | undefined;
let scrolling = false;
let queue: Promise<unknown> = Promise.resolve();
const endpoint = computed(() => `/api/cloud-browser/${encodeURIComponent(props.browserId)}`);
const imageSource = computed(() =>
  incomingFrame.value ? `data:image/jpeg;base64,${incomingFrame.value.image}` : undefined,
);
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
  scrollPending = undefined;
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
    incomingFrame.value = undefined;
    displayedFrame.value = undefined;
    state.value = undefined;
  }
  try {
    const initial = await request("state", {}, abort.signal);
    if (current !== generation) return;
    updateState(initial);
    await fitViewport();
    if (current !== generation) return;
    const events = new EventSource(withBaseUrl(`${endpoint.value}/events`));
    stream = events;
    events.onopen = () => {
      connection.value = "Live";
    };
    events.onerror = () => {
      if (current === generation) scheduleReconnect();
    };
    events.addEventListener("state", (event) => {
      if (current === generation) updateState(JSON.parse((event as MessageEvent).data));
    });
    events.addEventListener("frame", (event) => {
      if (current !== generation) return;
      const next = JSON.parse((event as MessageEvent).data) as BrowserFrame;
      reconnecting.value = false;
      reconnectAttempt = 0;
      connection.value = "Live";
      if (next.image === displayedFrame.value?.image) displayedFrame.value = next;
      incomingFrame.value = next;
    });
    events.addEventListener("browser-error", (event) => {
      if (current !== generation) return;
      const failure = JSON.parse((event as MessageEvent).data) as {
        error: string;
        retryable: boolean;
        statusCode?: number;
      };
      events.close();
      if (failure.retryable) scheduleReconnect();
      else {
        reconnecting.value = false;
        displayedFrame.value = undefined;
        error.value = failure.error;
        ended.value = failure.statusCode === 410;
      }
    });
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
  // Keep keyboard-only height changes stable, but still fit rotation/device changes.
  if (
    (editing.value || document.activeElement?.tagName === "INPUT") &&
    state.value?.width === width &&
    state.value.mobile === mobile
  )
    return;
  if (
    state.value?.width !== width ||
    state.value.height !== height ||
    state.value.mobile !== mobile
  )
    await control({ action: "viewport", width, height, mobile });
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
function point(clientX: number, clientY: number, rect: DOMRect, frame: BrowserFrame): Point {
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
function addScroll(anchor: Point, frame: BrowserFrame, deltaX: number, deltaY: number): void {
  if (
    scrollPending &&
    scrollPending.pageId === frame.pageId &&
    scrollPending.revision === frame.revision
  ) {
    scrollPending.deltaX += deltaX;
    scrollPending.deltaY += deltaY;
  } else
    scrollPending = { ...anchor, pageId: frame.pageId, revision: frame.revision, deltaX, deltaY };
  void flushScroll();
}
async function flushScroll(): Promise<void> {
  if (scrolling) return;
  scrolling = true;
  try {
    while (scrollPending) {
      const pending = scrollPending;
      scrollPending = undefined;
      if (
        !(await control({
          action: "scroll",
          ...pending,
          deltaX: Math.max(-10000, Math.min(10000, pending.deltaX)),
          deltaY: Math.max(-10000, Math.min(10000, pending.deltaY)),
        }))
      )
        scrollPending = undefined;
    }
  } finally {
    scrolling = false;
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
function frameLoaded(): void {
  if (image.value?.getAttribute("src") === imageSource.value)
    displayedFrame.value = incomingFrame.value;
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
        <img
          v-if="incomingFrame"
          ref="image"
          class="cloud-browser__image"
          :src="imageSource"
          :data-revision="displayedFrame?.revision"
          :width="incomingFrame.width"
          :height="incomingFrame.height"
          alt="Live browser page. Tap to click; swipe to scroll."
          draggable="false"
          @load="frameLoaded"
          @error="error = 'Browser image could not be loaded'"
          @pointerdown.prevent="pointerDown"
          @pointermove.prevent="pointerMove"
          @pointerup.prevent="pointerUp"
          @pointercancel="gesture = undefined"
          @lostpointercapture="gesture = undefined"
          @wheel.prevent="wheel"
          @contextmenu.prevent
        />
        <p v-else>{{ ended ? "Session unavailable" : connection }}</p>
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
