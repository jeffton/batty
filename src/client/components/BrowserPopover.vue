<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import FullPopover from "@/client/components/FullPopover.vue";
import BasePopover from "@/client/components/BasePopover.vue";
import { PanelsTopLeft, Check } from "@lucide/vue";
import BrowserCredentials from "@/client/components/BrowserCredentials.vue";
import { useBrowserTransport } from "@/client/browser/transport";
import { fitCloudViewport } from "@/shared/browser-geometry";

const props = defineProps<{ popoverId: string; browserId: string; title: string }>();
const viewport = ref<HTMLElement>();
const address = ref("");
const credentialsVisible = ref(false);
const tabs = ref<InstanceType<typeof BasePopover>>();
function selectTab(pageId: string): void {
  tabs.value?.hidePopover();
  void control({ action: "switch", pageId });
}
const addressInput = ref<HTMLInputElement>();
let addressWasFocused = false;
const viewStyle = ref<Record<string, string>>({});
let resizeObserver: ResizeObserver | undefined;
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
const browser = useBrowserTransport(() => props.browserId, {
  onState: (value, previous) => {
    credentialsVisible.value = true;
    if (previous?.url !== value.url) address.value = value.url;
    if (previous?.pageId !== value.pageId) scheduleResize();
  },
  onStop: () => {
    clearTimeout(resizeTimer);
    credentialsVisible.value = false;
    tabs.value?.hidePopover();
  },
  fitViewport,
});
const {
  state,
  ready,
  error,
  reconnecting,
  ended,
  control,
  startViewing,
  stopViewing,
  onToggle,
  onVisibility,
  onOnline,
  onOffline,
} = browser;
const { image, displayedFrame, hasFrame } = browser.frames;
const {
  editor,
  text,
  focused,
  editing,
  pointerDown,
  pointerMove,
  pointerUp,
  cancelGesture,
  wheel,
  beginComposition,
  scheduleInput,
  submitInput,
  dismissInput,
} = browser.input;

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
  const { width, height } = fitCloudViewport({
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  });
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
        <button
          type="button"
          :disabled="!ready"
          :popovertarget="`${popoverId}-tabs`"
          aria-label="Choose tab"
          title="Choose tab"
        >
          <PanelsTopLeft :size="18" />
        </button>
        <BasePopover :id="`${popoverId}-tabs`" ref="tabs" anchor-down class="cloud-browser-tabs">
          <button
            v-for="page in state?.pages"
            :key="page.id"
            type="button"
            :aria-current="page.active ? 'page' : undefined"
            @click="selectTab(page.id)"
          >
            <Check v-if="page.active" :size="16" aria-hidden="true" />
            <span class="cloud-browser-tabs__label">
              <strong>{{ page.title || page.url || "New tab" }}</strong>
              <small v-if="page.title">{{ page.url }}</small>
            </span>
          </button>
        </BasePopover>
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
          autocapitalize="none"
          autocorrect="off"
          :spellcheck="false"
          placeholder="Address"
        />
      </form>
    </template>
    <div class="cloud-browser">
      <div v-if="error" class="cloud-browser__error" role="alert">
        {{ error }} <button v-if="!ended" type="button" @click="startViewing">Reconnect</button>
      </div>
      <div ref="viewport" class="cloud-browser__viewport">
        <canvas
          v-show="hasFrame"
          ref="image"
          class="cloud-browser__image"
          :style="
            displayedFrame
              ? { aspectRatio: `${displayedFrame.width} / ${displayedFrame.height}` }
              : undefined
          "
          :data-revision="displayedFrame?.revision"
          role="img"
          aria-label="Live browser page. Tap to click; swipe to scroll."
          @pointerdown.prevent="pointerDown"
          @pointermove.prevent="pointerMove"
          @pointerup.prevent="pointerUp"
          @pointercancel="cancelGesture"
          @lostpointercapture="cancelGesture"
          @wheel.prevent="wheel"
          @contextmenu.prevent
        />
        <div
          v-if="reconnecting || (!hasFrame && !ended && !error)"
          class="cloud-browser__connection"
          role="status"
          :aria-label="reconnecting ? 'Reconnecting browser' : 'Connecting browser'"
        >
          <span class="cloud-browser__spinner" aria-hidden="true" />
        </div>
        <p v-if="!hasFrame && ended">Session unavailable</p>
      </div>
      <BrowserCredentials
        v-if="credentialsVisible && state?.login"
        :key="`${browserId}:${state.pageId}:${state.revision}:${state.url}:${state.login.id}`"
        :browser-id="browserId"
        :state="state"
      />
      <div v-if="editing && !(credentialsVisible && state?.login)" class="cloud-browser__editor">
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
:global(.cloud-browser-tabs) {
  width: 20rem;
  padding: 0.3rem;
  border: 1px solid var(--color-border-soft);
  border-radius: 0.6rem;
  background: var(--color-bg-panel);
  color: var(--color-text);
  box-shadow: var(--color-shadow-popover);
  overflow: auto;
}
.cloud-browser-tabs button {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.6rem;
  text-align: left;
  border: 0;
  border-radius: 0.4rem;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.cloud-browser-tabs button:hover,
.cloud-browser-tabs button[aria-current] {
  background: var(--color-bg-elevated);
}
.cloud-browser-tabs__label {
  display: grid;
  min-width: 0;
}
.cloud-browser-tabs__label strong,
.cloud-browser-tabs__label small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cloud-browser-tabs__label small {
  color: var(--color-text-muted);
}
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
  inset: 0;
  display: grid;
  place-items: center;
  pointer-events: none;
}
.cloud-browser__spinner {
  width: 2rem;
  height: 2rem;
  border: 3px solid var(--color-border-soft);
  border-top-color: var(--color-text);
  border-radius: 50%;
  animation: browser-spin 0.8s linear infinite;
}
@keyframes browser-spin {
  to {
    transform: rotate(360deg);
  }
}
.cloud-browser__viewport {
  position: relative;
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
  object-fit: fill;
  touch-action: none;
  user-select: none;
}
.cloud-browser__editor {
  flex-shrink: 0;
  padding: 0.4rem;
  border-top: 1px solid var(--color-border-soft);
}
</style>
