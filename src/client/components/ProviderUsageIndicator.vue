<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
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
const label = computed(() => rows.value.map((row) => row.label).join("\n"));

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
  <span v-if="rows.length" class="usage" role="img" :aria-label="label" :title="label">
    <svg :viewBox="`0 0 28 ${chartHeight}`" aria-hidden="true">
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
  </span>
  <span
    v-else-if="error"
    class="usage usage--error"
    role="img"
    :aria-label="`Usage limits unavailable: ${error}`"
    :title="`Usage limits unavailable: ${error}`"
    >!</span
  >
</template>

<style scoped>
.usage {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.6rem;
  height: 1.6rem;
  flex-shrink: 0;
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
</style>
