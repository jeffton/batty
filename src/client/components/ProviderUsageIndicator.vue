<script setup lang="ts">
import { computed, onUnmounted, ref, useId, watch } from "vue";
import BasePopover from "@/client/components/BasePopover.vue";
import { getProviderUsage } from "@/client/lib/api";
import { usageWindowDisplay } from "@/client/lib/provider-usage";
import type { ProviderUsageWindow } from "@/shared/types";

const props = defineProps<{ model?: string }>();
const windows = ref<ProviderUsageWindow[]>([]);
const error = ref("");
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

watch(
  () => props.model,
  (model, _, onCleanup) => {
    windows.value = [];
    error.value = "";
    if (!model) return;
    const separator = model.indexOf("/");
    const provider = model.slice(0, separator);
    const modelId = model.slice(separator + 1);
    let disposed = false;
    let pending = false;
    async function refresh() {
      if (pending) return;
      pending = true;
      try {
        const usage = await getProviderUsage(provider, modelId);
        if (!disposed) {
          windows.value = usage.windows;
          error.value = "";
        }
      } catch (cause) {
        if (!disposed) {
          windows.value = [];
          error.value = cause instanceof Error ? cause.message : String(cause);
        }
      } finally {
        pending = false;
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 60_000);
    onCleanup(() => {
      disposed = true;
      clearInterval(timer);
    });
  },
  { immediate: true },
);
const clock = setInterval(() => {
  now.value = Date.now();
}, 15_000);
onUnmounted(() => clearInterval(clock));
</script>

<template>
  <button
    v-if="rows.length || error"
    type="button"
    :class="['usage', { 'usage--error': error }]"
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
    :style="{ 'position-anchor': anchorName }"
    aria-label="Usage limits"
  >
    <div class="usage-details__heading">Usage limits</div>
    <p v-if="error" class="usage-details__error">{{ error }}</p>
    <div v-for="row in rows" :key="row.id" class="usage-details__window">
      {{ row.label }}
    </div>
    <p v-if="rows.length" class="usage-details__pace">Triangles mark on-pace remaining usage.</p>
  </BasePopover>
</template>

<style scoped>
.usage {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.6rem;
  height: 1.6rem;
  flex-shrink: 0;
  padding: 0;
  border: 0;
  border-radius: 0.35rem;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.usage:hover {
  background: var(--color-bg-elevated);
}
.usage:focus-visible {
  outline: 2px solid var(--color-text-subtle);
  outline-offset: 2px;
}
.usage svg {
  width: 100%;
  height: 100%;
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
.usage-details {
  display: none;
}
.usage-details:popover-open {
  position: fixed;
  position-area: block-end span-inline-start;
  position-try-fallbacks:
    block-end span-inline-end,
    block-start span-inline-start;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  width: min(18rem, calc(100vw - 1rem));
  margin: 0.35rem 0;
  padding: 0.75rem;
  border: 1px solid var(--color-border-soft);
  border-radius: 0.6rem;
  background: var(--color-bg-overlay);
  color: var(--color-text-strong);
  box-shadow: var(--color-shadow-popover);
  font-size: 0.8rem;
  overflow-wrap: anywhere;
}
.usage-details__heading {
  font-weight: 600;
}
.usage-details__window {
  line-height: 1.5;
}
.usage-details__pace {
  margin: 0;
  color: var(--color-text-subtle);
  font-size: 0.75rem;
}
.usage-details__error {
  margin: 0;
  color: var(--color-warning);
}
</style>
