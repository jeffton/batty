<script setup lang="ts">
import { X } from "@lucide/vue";
import { ref } from "vue";

const props = withDefaults(
  defineProps<{
    popoverId: string;
    title: string;
    subtitle?: string;
    anchorName?: string;
    closeLabel?: string;
  }>(),
  {
    subtitle: undefined,
    anchorName: undefined,
    closeLabel: "Close popover",
  },
);

const emit = defineEmits<{
  toggle: [event: Event];
}>();

const popoverElement = ref<HTMLElement | null>(null);
</script>

<template>
  <div
    :id="props.popoverId"
    ref="popoverElement"
    class="full-popover"
    :style="props.anchorName ? { 'position-anchor': props.anchorName } : undefined"
    popover="auto"
    @toggle="emit('toggle', $event)"
  >
    <header class="full-popover__header">
      <div class="full-popover__heading">
        <div class="full-popover__title">{{ props.title }}</div>
        <div v-if="props.subtitle" class="full-popover__subtitle">{{ props.subtitle }}</div>
      </div>
      <div class="full-popover__header-actions">
        <slot name="header-actions" />
        <button
          type="button"
          class="full-popover__close"
          :aria-label="props.closeLabel"
          title="Close"
          @click="popoverElement?.hidePopover?.()"
        >
          <X :size="16" />
        </button>
      </div>
      <div v-if="$slots['header-content']" class="full-popover__header-content">
        <slot name="header-content" />
      </div>
    </header>
    <div class="full-popover__body">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.full-popover {
  inset: calc(var(--safe-area-top) + 1rem) calc(var(--safe-area-right) + 1rem)
    calc(var(--safe-area-bottom) + 1rem) calc(var(--safe-area-left) + 1rem);
  width: auto;
  max-width: none;
  height: auto;
  max-height: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--color-border-soft);
  border-radius: 0.9rem;
  background: var(--color-bg-panel);
  color: var(--color-text);
  box-shadow: var(--color-shadow-popover);
  overflow: hidden;
  overscroll-behavior: contain;
}

.full-popover:popover-open {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
}

.full-popover::backdrop {
  background: rgb(0 0 0 / 0.22);
}

.full-popover__header {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.5rem 1rem;
  padding: 0.9rem 1rem 0.75rem;
  border-bottom: 1px solid var(--color-border-soft);
  background: var(--color-bg-panel-strong);
  box-shadow: var(--color-shadow-header);
}

.full-popover__heading {
  min-width: 0;
}

.full-popover__title {
  font-size: 1rem;
  font-weight: 700;
  color: var(--color-text-strong);
}

.full-popover__subtitle {
  overflow: hidden;
  color: var(--color-text-subtle);
  font-size: 0.78rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.full-popover__header-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.35rem;
  flex-shrink: 0;
}

.full-popover__header-content {
  grid-column: 1 / -1;
  min-width: 0;
}

.full-popover__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  padding: 0;
  border: 1px solid var(--color-border-soft);
  border-radius: 0.5rem;
  background: var(--color-bg-panel);
  color: var(--color-text);
  cursor: pointer;
}

.full-popover__body {
  min-height: 0;
  overflow: hidden;
}

@media (hover: hover) {
  .full-popover__close:hover {
    background: var(--color-bg-elevated-soft);
  }
}
</style>
