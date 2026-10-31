<script setup lang="ts">
import { computed, onUnmounted, ref, useId } from "vue";
import BasePopover from "@/client/components/BasePopover.vue";
import { usageWindowDisplay } from "@/client/lib/provider-usage";
import type { ProviderUsageUpdate } from "@/shared/types";

const props = defineProps<{ model?: string; update?: ProviderUsageUpdate }>();
const update = computed(() =>
  props.model?.startsWith(`${props.update?.provider}/`) ? props.update : undefined,
);
const windows = computed(() => {
  const usage = update.value?.usage;
  const model = props.model?.slice(props.model.indexOf("/") + 1).toLowerCase();
  return [...(usage?.windows ?? []), ...(usage?.modelWindows?.[model ?? ""] ?? [])];
});
const error = computed(() => update.value?.error ?? "");
const now = ref(Date.now());
const rows = computed(() =>
  windows.value.map((window) => ({
    id: window.id,
    ...usageWindowDisplay(window, now.value),
  })),
);
const chartHeight = computed(() => Math.max(28, rows.value.length * 10 + 4));
const popoverId = `usage-${useId()}`;
const anchorName = `--${popoverId}`;

const clock = setInterval(() => {
  now.value = Date.now();
}, 15_000);
onUnmounted(() => clearInterval(clock));
</script>

<template>
  <button
    v-if="rows.length || error"
    type="button"
    :class="['usage', 'chrome-button', 'chrome-button--icon', { 'usage--error': error }]"
    :aria-label="error ? 'Usage limits unavailable' : 'Usage limits'"
    :popovertarget="popoverId"
    :style="{ 'anchor-name': anchorName }"
  >
    <svg v-if="rows.length" :viewBox="`0 0 28 ${chartHeight}`" aria-hidden="true">
      <g
        v-for="(row, index) in rows"
        :key="row.id"
        :transform="`translate(3, ${(chartHeight - rows.length * 10 + 2) / 2 + index * 10})`"
      >
        <rect class="usage__track" width="22" height="4" rx="2" />
        <rect
          class="usage__fill"
          :width="(22 * row.remaining) / 100"
          height="4"
          :rx="Math.min(2, (11 * row.remaining) / 100)"
        />
        <path
          class="usage__pointer"
          :transform="`translate(${22 * row.pace}, 5)`"
          d="M 0 0 L 2 3 L -2 3 Z"
        />
      </g>
    </svg>
    <span v-else aria-hidden="true">!</span>
  </button>
  <BasePopover
    v-if="rows.length || error"
    :id="popoverId"
    class="usage-details"
    floating
    anchor-down
    align-viewport-right
    :style="{ 'position-anchor': anchorName }"
    aria-label="Usage limits"
  >
    <div class="usage-details__heading">Usage limits</div>
    <p v-if="error" class="usage-details__error">{{ error }}</p>
    <div v-for="row in rows" :key="row.id" class="usage-details__window">
      <div>{{ row.label }} · {{ row.paceLabel }}</div>
      <div class="usage-details__reset">{{ row.resetLabel }}</div>
    </div>
  </BasePopover>
</template>

<style scoped>
.usage svg {
  width: 1.6rem;
  height: 1.6rem;
}
.usage__track {
  fill: var(--color-border-soft);
}
.usage__fill {
  fill: var(--color-success);
}
.usage__pointer {
  fill: var(--color-text-subtle);
}
.usage--error {
  color: var(--color-warning);
  font-size: 0.8rem;
}
:global(.usage-details) {
  display: none;
}
:global(.usage-details:popover-open) {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  width: min(18rem, calc(100vw - 1rem));
  margin: 0;
  padding: 0.75rem;
  font-size: 0.8rem;
  overflow-wrap: anywhere;
}
.usage-details__heading {
  font-weight: 600;
}
.usage-details__window {
  line-height: 1.5;
}
.usage-details__reset {
  color: var(--color-text-subtle);
  font-size: 0.75rem;
}
.usage-details__error {
  margin: 0;
  color: var(--color-warning);
}
</style>
