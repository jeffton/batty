<script setup lang="ts">
import { Square } from "@lucide/vue";

const props = defineProps<{
  disabled?: boolean;
  label?: string;
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
    <span class="spinner streaming-stop-control__spinner" aria-hidden="true" />
    <button
      class="streaming-stop-control__button"
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

.streaming-stop-control__spinner {
  width: 1rem;
  height: 1rem;
  border-width: 2px;
}

.streaming-stop-control__button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 2.5rem;
  min-height: 2.5rem;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--color-error);
  cursor: pointer;
  transition:
    background 80ms ease,
    color 80ms ease;
}

@media (hover: hover) {
  .streaming-stop-control__button:hover:not(:disabled) {
    background: var(--color-bg-elevated);
  }
}

.streaming-stop-control__button:disabled {
  opacity: 0.4;
  cursor: default;
}

.streaming-stop-control__button :deep(svg) {
  display: block;
}
</style>
