<script setup lang="ts">
import { Square } from "@lucide/vue";

const props = defineProps<{
  disabled?: boolean;
  label?: string;
  compacting?: boolean;
  statusLabel?: string;
  hideStop?: boolean;
}>();

const emit = defineEmits<{
  stop: [];
}>();

let triggeredEarlyAt = 0;

function triggerEarly(event: PointerEvent): void {
  if (event.pointerType === "mouse" || props.disabled) {
    return;
  }

  event.preventDefault();
  triggeredEarlyAt = Date.now();
  emit("stop");
}

function triggerClick(): void {
  if (props.disabled) {
    return;
  }
  if (Date.now() - triggeredEarlyAt < 1000) {
    triggeredEarlyAt = 0;
    return;
  }

  emit("stop");
}
</script>

<template>
  <div class="streaming-stop-control">
    <span
      v-if="props.statusLabel || props.compacting"
      class="streaming-stop-control__status"
      :title="props.statusLabel ?? 'Compacting'"
      >{{ props.statusLabel ?? "Compacting" }}</span
    >
    <span class="spinner streaming-stop-control__spinner" aria-hidden="true" />
    <button
      v-if="!props.hideStop"
      class="streaming-stop-control__button chrome-button chrome-button--icon chrome-button--danger"
      type="button"
      :aria-label="props.label ?? 'Stop'"
      :title="props.label ?? 'Stop'"
      :disabled="props.disabled"
      @pointerdown="triggerEarly"
      @click="triggerClick"
    >
      <Square :size="16" />
    </button>
  </div>
</template>

<style scoped>
.streaming-stop-control {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  flex-shrink: 0;
}

.streaming-stop-control__status {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 0.35rem 0.55rem;
  border-radius: 0.5rem;
  background: var(--color-chrome-hover);
  color: var(--color-link);
  font-size: 0.78rem;
  line-height: 1;
  white-space: nowrap;
}

.streaming-stop-control__spinner {
  width: 1rem;
  height: 1rem;
  border-width: 2px;
  flex-shrink: 0;
}

.streaming-stop-control__button :deep(svg) {
  display: block;
}
</style>
