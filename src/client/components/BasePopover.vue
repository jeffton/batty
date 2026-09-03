<script setup lang="ts">
import { ref } from "vue";

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    as?: "div" | "form";
    mode?: "auto" | "manual";
  }>(),
  {
    as: "div",
    mode: "auto",
  },
);

const emit = defineEmits<{
  toggle: [event: Event];
}>();

const element = ref<HTMLElement | null>(null);

function showPopover(): void {
  element.value?.showPopover();
}

function hidePopover(): void {
  element.value?.hidePopover();
}

function togglePopover(force?: boolean): void {
  element.value?.togglePopover(force);
}

defineExpose({ element, showPopover, hidePopover, togglePopover });
</script>

<template>
  <component
    :is="props.as"
    ref="element"
    class="base-popover"
    :popover="props.mode"
    v-bind="$attrs"
    @toggle="emit('toggle', $event)"
  >
    <slot />
  </component>
</template>

<style scoped>
.base-popover,
.base-popover :deep(*) {
  overscroll-behavior: contain;
}
</style>
