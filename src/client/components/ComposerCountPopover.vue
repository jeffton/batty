<script setup lang="ts">
import { computed, ref } from "vue";
import BasePopover from "./BasePopover.vue";

const props = withDefaults(
  defineProps<{
    id: string;
    label: string;
    noun: "task" | "draft";
    count: number;
    dialogLabel?: string;
    triggerClass?: string;
    showTrigger?: boolean;
    alignNarrowViewportLeft?: boolean;
  }>(),
  { showTrigger: true },
);
const nounLabel = computed(() => ` ${props.noun}${props.count === 1 ? "" : "s"}`);
const countLabel = computed(() => `${props.count}${nounLabel.value}`);
const emit = defineEmits<{ toggle: [event: Event] }>();
const popover = ref<InstanceType<typeof BasePopover>>();
defineExpose({ close: () => popover.value?.hidePopover() });
</script>

<template>
  <button
    v-if="showTrigger"
    class="composer-count-control chrome-button"
    :class="triggerClass"
    type="button"
    :popovertarget="id"
    :aria-label="label"
    :title="countLabel"
    aria-haspopup="dialog"
  >
    <slot name="icon" />
    <span class="composer-count-control__info">
      <span class="composer-count-control__label"
        >{{ count }}<span class="composer-count-control__noun">{{ nounLabel }}</span></span
      >
      <span class="composer-count-control__status"><slot name="status" /></span>
    </span>
  </button>
  <BasePopover
    :id="id"
    ref="popover"
    class="composer-list-popover"
    floating
    anchor-up
    align-anchor-left
    :align-narrow-viewport-left="alignNarrowViewportLeft"
    role="dialog"
    :aria-label="dialogLabel ?? label"
    @toggle="emit('toggle', $event)"
  >
    <div class="composer-list-popover__list">
      <slot />
    </div>
  </BasePopover>
</template>

<style>
.chrome-button.composer-count-control {
  --chrome-button-ink: var(--color-text-muted);
  min-width: var(--button-size);
  min-height: var(--button-size);
  flex: 0 1 auto;
  padding: 0 calc((var(--button-size) - var(--button-icon-size)) / 2);
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-family: inherit;
  font-size: 0.78rem;
  white-space: nowrap;
  cursor: pointer;
}

.composer-count-control > svg {
  flex: none;
}

.composer-count-control__info {
  --button-icon-size: 0.7rem;
  min-width: 0;
  display: grid;
  gap: 0.2rem;
  text-align: left;
  line-height: 1.05;
}

.composer-count-control__label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.8rem;
}

@media (prefers-color-scheme: dark) {
  .composer-count-control__label {
    /* Small text needs more contrast than icons on the tinted button states. */
    color: color-mix(in oklch, currentColor, var(--color-text));
  }
}

/* Keep the counts readable when two full labels and both send controls do not fit. */
@media (max-width: 22rem) {
  .composer-count-control__noun {
    display: none;
  }
}

.composer-count-control__status {
  position: relative;
  height: 0.7rem;
}

.composer-list-popover {
  display: none;
}

.composer-list-popover:popover-open {
  display: flex;
  flex-direction: column;
  width: min(22rem, calc(100vw - 1rem));
  --anchored-popover-max-height: 24rem;
  max-height: 24rem;
  overflow: hidden;
  padding: 0;
}

.composer-list-popover__header {
  position: sticky;
  top: 0;
  z-index: 1;
  flex-shrink: 0;
  padding: 0.9rem 1rem 0.75rem;
  border-bottom: 1px solid var(--color-chrome-border);
  background: var(--color-bg-instance);
  color: var(--color-text-strong);
  font-size: 1rem;
  font-weight: 700;
}

.composer-list-popover__list {
  min-height: 0;
  overflow-y: auto;
  background: var(--color-bg-app);
}

.composer-list-popover__empty {
  margin: 0;
  padding: 0.5rem;
  color: var(--color-text-subtle);
}
</style>
