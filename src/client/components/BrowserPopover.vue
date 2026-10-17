<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import FullPopover from "@/client/components/FullPopover.vue";
import { withBaseUrl } from "@/client/lib/base-url";

import {
  CLOUD_BROWSER_KEYS,
  type CloudBrowserState as BrowserState,
  type CloudBrowserFrame as BrowserFrame,
} from "@/shared/cloud-browser";
type Point = { x: number; y: number };
type Gesture = Point & {
  pointerId: number;
  clientX: number;
  clientY: number;
  frame: BrowserFrame;
  rect: DOMRect;
  drag: boolean;
};

const props = defineProps<{ popoverId: string; browserId: string; title: string }>();
const state = ref<BrowserState>();
const incomingFrame = ref<BrowserFrame>();
const displayedFrame = ref<BrowserFrame>();
const image = ref<HTMLImageElement>();
const address = ref("");
const text = ref("");
const error = ref("");
const connection = ref("Connecting…");
const busy = ref(false);
const dragMode = ref(false);
const open = ref(false);
const ended = ref(false);
const viewStyle = ref<Record<string, string>>({});
let stream: EventSource | undefined;
let controller: AbortController | undefined;
let generation = 0;
let gesture: Gesture | undefined;
const endpoint = computed(() => `/api/cloud-browser/${encodeURIComponent(props.browserId)}`);
const imageSource = computed(() =>
  incomingFrame.value ? `data:image/jpeg;base64,${incomingFrame.value.image}` : undefined,
);
const ready = computed(() => !busy.value && !ended.value && !!state.value);
const frameReady = computed(
  () =>
    ready.value &&
    !!displayedFrame.value &&
    displayedFrame.value === incomingFrame.value &&
    displayedFrame.value.pageId === state.value?.pageId &&
    displayedFrame.value.revision === state.value?.revision,
);
const keys = CLOUD_BROWSER_KEYS;

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
    throw new Error(body.error);
  }
  return (await response.json()) as BrowserState;
}

function updateState(value: BrowserState): void {
  if (state.value?.url !== value.url) address.value = value.url;
  state.value = value;
}

function stopViewing(): void {
  generation++;
  stream?.close();
  stream = undefined;
  controller?.abort();
  controller = undefined;
  gesture = undefined;
  busy.value = false;
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
  incomingFrame.value = undefined;
  displayedFrame.value = undefined;
  state.value = undefined;
  try {
    const value = await request("state", {}, abort.signal);
    if (current !== generation) return;
    updateState(value);
    const events = new EventSource(withBaseUrl(`${endpoint.value}/events`));
    stream = events;
    events.onopen = () => {
      connection.value = "Live";
    };
    events.onerror = () => {
      connection.value = "Reconnecting…";
    };
    events.addEventListener("state", (event) => {
      if (current === generation) updateState(JSON.parse((event as MessageEvent).data));
    });
    events.addEventListener("frame", (event) => {
      if (current !== generation) return;
      const next = JSON.parse((event as MessageEvent).data) as BrowserFrame;
      // Unchanged pixels do not trigger another image load, but carry a new revision.
      if (next.image === displayedFrame.value?.image) displayedFrame.value = next;
      incomingFrame.value = next;
    });
    events.addEventListener("browser-error", (event) => {
      if (current !== generation) return;
      error.value = JSON.parse((event as MessageEvent).data).error;
      ended.value = true;
      events.close();
      connection.value = "Disconnected";
    });
  } catch (cause) {
    if (current === generation && !abort.signal.aborted) {
      error.value = (cause as Error).message;
      connection.value = "Disconnected";
    }
  }
}

function onToggle(event: Event): void {
  open.value = (event as ToggleEvent).newState === "open";
  if (open.value) void startViewing();
  else stopViewing();
}
function resizeView(): void {
  const viewport = window.visualViewport;
  viewStyle.value = {
    top: `calc(${viewport?.offsetTop ?? 0}px + var(--safe-area-top) + 1rem)`,
    bottom: "auto",
    height: `calc(${viewport?.height ?? window.innerHeight}px - var(--safe-area-top) - var(--safe-area-bottom) - 2rem)`,
  };
}
function onVisibility(): void {
  if (document.hidden) stopViewing();
  else if (open.value) void startViewing();
}

async function control(command: Record<string, unknown>): Promise<boolean> {
  if (!ready.value || !controller) return false;
  const current = generation;
  busy.value = true;
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
  } finally {
    if (current === generation) busy.value = false;
  }
}

function point(clientX: number, clientY: number, rect: DOMRect, frame: BrowserFrame): Point {
  return {
    x: Math.round(((clientX - rect.left) * frame.width) / rect.width),
    y: Math.round(((clientY - rect.top) * frame.height) / rect.height),
  };
}
function pointerDown(event: PointerEvent): void {
  if (!frameReady.value || event.button !== 0 || gesture) return;
  const rect = image.value!.getBoundingClientRect();
  const frame = displayedFrame.value!;
  gesture = {
    ...point(event.clientX, event.clientY, rect, frame),
    clientX: event.clientX,
    clientY: event.clientY,
    pointerId: event.pointerId,
    rect,
    frame,
    drag: dragMode.value,
  };
  image.value!.setPointerCapture(event.pointerId);
}
function pointerUp(event: PointerEvent): void {
  const start = gesture;
  if (!start || event.pointerId !== start.pointerId) return;
  gesture = undefined;
  const end = point(event.clientX, event.clientY, start.rect, start.frame);
  const common = {
    pageId: start.frame.pageId,
    revision: start.frame.revision,
    x: start.x,
    y: start.y,
  };
  if (Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) < 8) {
    void control({ action: "click", ...common });
  } else if (start.drag) {
    void control({ action: "drag", ...common, endX: end.x, endY: end.y });
  } else {
    void control({ action: "scroll", ...common, deltaX: start.x - end.x, deltaY: start.y - end.y });
  }
}
function frameLoaded(): void {
  if (image.value?.getAttribute("src") === imageSource.value)
    displayedFrame.value = incomingFrame.value;
}
function sendKey(key: string): void {
  const frame = displayedFrame.value;
  if (frameReady.value && frame)
    void control({ action: "key", key, pageId: frame.pageId, revision: frame.revision });
}
async function sendText(): Promise<void> {
  const frame = displayedFrame.value;
  const value = text.value;
  if (!frameReady.value || !frame || !value) return;
  if (
    await control({ action: "text", text: value, pageId: frame.pageId, revision: frame.revision })
  ) {
    if (text.value === value) text.value = "";
  }
}

onMounted(() => {
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("resize", resizeView);
  window.visualViewport?.addEventListener("resize", resizeView);
  window.visualViewport?.addEventListener("scroll", resizeView);
  resizeView();
});
onBeforeUnmount(() => {
  stopViewing();
  document.removeEventListener("visibilitychange", onVisibility);
  window.removeEventListener("resize", resizeView);
  window.visualViewport?.removeEventListener("resize", resizeView);
  window.visualViewport?.removeEventListener("scroll", resizeView);
});
</script>

<template>
  <FullPopover
    :popover-id="popoverId"
    :title="title"
    :style="viewStyle"
    subtitle="Shared cloud browser · closing this view keeps the browser running"
    @toggle="onToggle"
  >
    <div class="cloud-browser">
      <div class="cloud-browser__toolbar">
        <form
          class="cloud-browser__row"
          @submit.prevent="control({ action: 'navigate', url: address })"
        >
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
            v-model="address"
            aria-label="Browser address"
            type="text"
            inputmode="url"
            autocapitalize="off"
            :spellcheck="false"
            placeholder="https://…"
          />
          <button :disabled="!ready || !address.trim()" type="submit">Go</button>
        </form>
        <div class="cloud-browser__row">
          <select
            aria-label="Browser tab"
            :value="state?.pageId"
            :disabled="!ready"
            @change="
              control({ action: 'switch', pageId: ($event.target as HTMLSelectElement).value })
            "
          >
            <option v-for="tab in state?.pages" :key="tab.id" :value="tab.id">
              {{ tab.title || tab.url || "New tab" }}
            </option>
          </select>
          <button
            type="button"
            :disabled="!ready"
            @click="control({ action: 'close-page', pageId: state?.pageId })"
          >
            Close tab
          </button>
          <label class="cloud-browser__drag"
            ><input v-model="dragMode" type="checkbox" />Drag</label
          >
        </div>
        <div class="cloud-browser__row">
          <label :for="`${popoverId}-size`">Page size</label>
          <select
            :id="`${popoverId}-size`"
            aria-label="Remote page size"
            :value="state ? `${state.width}x${state.height}` : ''"
            :disabled="!ready"
            @change="
              control({
                action: 'viewport',
                width: Number(($event.target as HTMLSelectElement).value.split('x')[0]),
                height: Number(($event.target as HTMLSelectElement).value.split('x')[1]),
              })
            "
          >
            <option
              v-if="state && !['390x844', '1280x800'].includes(`${state.width}x${state.height}`)"
              :value="`${state.width}x${state.height}`"
            >
              {{ state.width }} × {{ state.height }}
            </option>
            <option value="390x844">Phone · 390 × 844</option>
            <option value="1280x800">Desktop · 1280 × 800</option>
          </select>
        </div>
        <div class="cloud-browser__status" role="status">
          {{ ended ? "Session unavailable" : connection }}<span v-if="busy"> · Sending…</span>
        </div>
        <div v-if="error" class="cloud-browser__error" role="alert">
          {{ error }} <button type="button" @click="startViewing">Reconnect</button>
        </div>
      </div>
      <div class="cloud-browser__viewport">
        <img
          v-if="incomingFrame"
          ref="image"
          class="cloud-browser__image"
          :src="imageSource"
          :width="incomingFrame.width"
          :height="incomingFrame.height"
          alt="Live browser page. Tap to click; swipe to scroll."
          draggable="false"
          @load="frameLoaded"
          @error="error = 'Browser image could not be loaded'"
          @pointerdown.prevent="pointerDown"
          @pointerup.prevent="pointerUp"
          @pointercancel="gesture = undefined"
          @lostpointercapture="gesture = undefined"
          @contextmenu.prevent
        />
        <p v-else>
          {{ ended ? "The browser session is unavailable." : "Waiting for browser image…" }}
        </p>
      </div>
      <div class="cloud-browser__input">
        <form class="cloud-browser__row" @submit.prevent="sendText">
          <input
            v-model="text"
            aria-label="Text for focused browser field"
            type="text"
            placeholder="Tap a field above, then type here"
          />
          <button type="submit" :disabled="!frameReady || !text">Send</button>
        </form>
        <div class="cloud-browser__keys" aria-label="Browser keyboard">
          <button
            v-for="key in keys"
            :key="key"
            type="button"
            :disabled="!frameReady"
            @click="sendKey(key)"
          >
            {{ key }}
          </button>
        </div>
      </div>
    </div>
  </FullPopover>
</template>

<style scoped>
.cloud-browser {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  color: var(--color-text);
  background: var(--color-bg-panel);
}
.cloud-browser__toolbar,
.cloud-browser__input {
  display: grid;
  flex-shrink: 0;
  gap: 0.45rem;
  padding: 0.65rem;
}
.cloud-browser__input {
  border-top: 1px solid var(--color-border-soft);
}
.cloud-browser__row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  min-width: 0;
}
.cloud-browser button,
.cloud-browser input,
.cloud-browser select {
  min-height: 2.3rem;
  padding: 0.35rem 0.55rem;
  border: 1px solid var(--color-border-soft);
  border-radius: 0.45rem;
  background: var(--color-bg-panel);
  color: inherit;
  font: inherit;
  font-size: 1rem;
}
.cloud-browser button {
  cursor: pointer;
  flex-shrink: 0;
}
.cloud-browser button:disabled {
  opacity: 0.5;
  cursor: default;
}
.cloud-browser input:not([type="checkbox"]),
.cloud-browser select {
  flex: 1;
  min-width: 0;
  width: 0;
}
.cloud-browser__drag {
  display: flex;
  align-items: center;
  gap: 0.3rem;
}
.cloud-browser__drag input {
  min-height: auto;
}
.cloud-browser__status {
  color: var(--color-text-muted);
  font-size: 0.8rem;
}
.cloud-browser__error {
  overflow-wrap: anywhere;
}
.cloud-browser__viewport {
  flex: 1 0 8rem;
  min-height: 8rem;
  overflow: auto;
  overscroll-behavior: contain;
}
.cloud-browser__viewport p {
  padding: 1rem;
}
.cloud-browser__image {
  display: block;
  width: 100%;
  height: auto;
  touch-action: none;
  user-select: none;
}
.cloud-browser__keys {
  display: flex;
  gap: 0.35rem;
  overflow-x: auto;
}
@media (hover: hover) {
  .cloud-browser button:hover:not(:disabled) {
    background: var(--color-bg-elevated-soft);
  }
}
</style>
