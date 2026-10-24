<script setup lang="ts">
import { ref } from "vue";
import FullPopover from "./FullPopover.vue";

const props = defineProps<{ popoverId: string; src: string; alt: string }>();
const open = ref(false);
const failed = ref(false);
const scale = ref(1);
const x = ref(0);
const y = ref(0);
const surface = ref<HTMLElement>();
const pointers = new Map<number, { x: number; y: number }>();
let gesture: {
  x: number;
  y: number;
  distance: number;
  scale: number;
  offsetX: number;
  offsetY: number;
};

function reset(): void {
  scale.value = 1;
  x.value = y.value = 0;
  pointers.clear();
}
function zoom(value: number): void {
  const next = Math.max(1, Math.min(8, value));
  x.value *= next / scale.value;
  y.value *= next / scale.value;
  scale.value = next;
  if (next === 1) x.value = y.value = 0;
}
function geometry() {
  const [a, b = a] = [...pointers.values()];
  const rect = surface.value!.getBoundingClientRect();
  return {
    x: (a!.x + b!.x) / 2 - rect.left - rect.width / 2,
    y: (a!.y + b!.y) / 2 - rect.top - rect.height / 2,
    distance: Math.hypot(b!.x - a!.x, b!.y - a!.y),
  };
}
function beginGesture(): void {
  if (pointers.size)
    gesture = { ...geometry(), scale: scale.value, offsetX: x.value, offsetY: y.value };
}
function pointerDown(event: PointerEvent): void {
  if (event.button !== 0) return;
  surface.value!.setPointerCapture(event.pointerId);
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  beginGesture();
}
function pointerMove(event: PointerEvent): void {
  if (!pointers.has(event.pointerId)) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  const current = geometry();
  const next = Math.max(
    1,
    Math.min(8, gesture.scale * (gesture.distance ? current.distance / gesture.distance : 1)),
  );
  const ratio = next / gesture.scale;
  scale.value = next;
  x.value = current.x - (gesture.x - gesture.offsetX) * ratio;
  y.value = current.y - (gesture.y - gesture.offsetY) * ratio;
  if (next === 1) x.value = y.value = 0;
}
function pointerUp(event: PointerEvent): void {
  pointers.delete(event.pointerId);
  beginGesture();
}
function keyDown(event: KeyboardEvent): void {
  const directions: Record<string, [number, number]> = {
    ArrowLeft: [40, 0],
    ArrowRight: [-40, 0],
    ArrowUp: [0, 40],
    ArrowDown: [0, -40],
  };
  const direction = directions[event.key];
  if (!direction) return;
  event.preventDefault();
  if (scale.value === 1) return;
  x.value += direction[0];
  y.value += direction[1];
}
function onToggle(event: Event): void {
  open.value = (event as ToggleEvent).newState === "open";
  reset();
  failed.value = false;
}
</script>

<template>
  <FullPopover
    :popover-id="props.popoverId"
    :title="props.alt"
    close-label="Close image"
    role="dialog"
    :aria-label="props.alt"
    @toggle="onToggle"
  >
    <template #header-actions>
      <button
        type="button"
        aria-label="Zoom out"
        :disabled="scale === 1"
        @click="zoom(scale / 1.5)"
      >
        −
      </button>
      <button type="button" aria-label="Reset zoom" @click="reset">
        {{ Math.round(scale * 100) }}%
      </button>
      <button type="button" aria-label="Zoom in" :disabled="scale === 8" @click="zoom(scale * 1.5)">
        +
      </button>
    </template>
    <div
      ref="surface"
      class="image-viewer"
      tabindex="0"
      role="region"
      aria-label="Image viewer. Use arrow keys to pan when zoomed."
      @keydown="keyDown"
      @pointerdown.prevent="pointerDown"
      @pointermove="pointerMove"
      @pointerup="pointerUp"
      @pointercancel="pointerUp"
      @lostpointercapture="pointerUp"
    >
      <span v-if="failed" role="alert">Image unavailable</span>
      <img
        v-else-if="open"
        :src="props.src"
        :alt="props.alt"
        draggable="false"
        :style="{ transform: `translate(${x}px, ${y}px) scale(${scale})` }"
        @error="failed = true"
      />
    </div>
  </FullPopover>
</template>

<style scoped>
.image-viewer {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  overflow: hidden;
  touch-action: none;
  user-select: none;
  background: #161616;
  color: white;
  cursor: grab;
}
.image-viewer:active {
  cursor: grabbing;
}
.image-viewer img {
  display: block;
  width: 100%;
  height: 100%;
  min-height: 0;
  object-fit: contain;
  pointer-events: none;
}
</style>
