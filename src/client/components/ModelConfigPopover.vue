<script setup lang="ts">
import type { ModelOption } from "@/shared/types";
import { Search } from "lucide-vue-next";
import { computed, ref, watch } from "vue";

const props = defineProps<{
  popoverId: string;
  anchorName: string;
  models: ModelOption[];
  currentModelId?: string;
  currentThinkingLevel: string;
  thinkingOptions: string[];
}>();

const emit = defineEmits<{
  setModel: [modelId: string];
  setThinkingLevel: [thinkingLevel: string];
  close: [];
}>();

const modelFilter = ref("");

const filteredModels = computed(() => {
  const query = modelFilter.value.toLowerCase().trim();
  const models = query
    ? props.models.filter(
        (m) =>
          m.label.toLowerCase().includes(query) ||
          m.provider.toLowerCase().includes(query) ||
          m.id.toLowerCase().includes(query),
      )
    : props.models;

  return [...models].sort((a, b) => {
    const providerCmp = a.provider.localeCompare(b.provider);
    if (providerCmp !== 0) return providerCmp;
    return shortModelLabel(a).localeCompare(shortModelLabel(b));
  });
});

function shortModelLabel(model: Pick<ModelOption, "label">): string {
  return model.label.split(" · ", 1)[0] ?? model.label;
}

function thinkingLabel(value: string): string {
  return value === "xhigh" ? "XHigh" : value.charAt(0).toUpperCase() + value.slice(1);
}

// Reset filter when popover opens
watch(
  () => document.getElementById(props.popoverId)?.matches(":popover-open"),
  (open) => {
    if (open) modelFilter.value = "";
  },
);
</script>

<template>
  <div
    :id="props.popoverId"
    class="mc-popover"
    :style="{ 'position-anchor': props.anchorName }"
    popover="auto"
  >
    <div class="mc-popover__thinking">
      <button
        v-for="option in props.thinkingOptions"
        :key="option"
        type="button"
        :class="[
          'mc-popover__thinking-btn',
          option === props.currentThinkingLevel ? 'is-active' : '',
        ]"
        @click="emit('setThinkingLevel', option)"
      >
        {{ thinkingLabel(option) }}
      </button>
    </div>

    <div class="mc-popover__search-row">
      <Search :size="14" class="mc-popover__search-icon" />
      <input
        v-model="modelFilter"
        class="mc-popover__search"
        type="text"
        placeholder="Filter models…"
      />
    </div>

    <div class="mc-popover__models">
      <button
        v-for="model in filteredModels"
        :key="model.id"
        type="button"
        :class="['mc-popover__model', model.id === props.currentModelId ? 'is-active' : '']"
        @click="emit('setModel', model.id)"
      >
        <span class="mc-popover__model-name">{{ shortModelLabel(model) }}</span>
        <span class="mc-popover__model-provider">{{ model.provider }}</span>
      </button>
      <div v-if="filteredModels.length === 0" class="mc-popover__empty">No models match.</div>
    </div>
  </div>
</template>

<style scoped>
.mc-popover {
  display: none;
}

.mc-popover:popover-open {
  position: absolute;
  top: calc(anchor(bottom) + 0.3rem);
  right: auto;
  left: anchor(left);
  width: min(22rem, calc(100vw - 1.5rem));
  max-height: min(28rem, calc(100dvh - 4rem));
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0.5rem;
  border: 1px solid var(--color-border-soft);
  border-radius: 0.75rem;
  background: var(--color-bg-overlay);
  color: inherit;
  box-shadow: var(--color-shadow-popover);
  gap: 0.35rem;
}

.mc-popover::backdrop {
  background: var(--color-backdrop);
}

.mc-popover__thinking {
  display: flex;
  gap: 0.25rem;
  padding: 0.15rem;
  background: var(--color-bg-elevated);
  border-radius: 0.45rem;
}

.mc-popover__thinking-btn {
  flex: 1;
  border: 0;
  border-radius: 0.35rem;
  background: transparent;
  color: var(--color-text-muted);
  padding: 0.3rem 0.4rem;
  font-size: 0.82rem;
  font-weight: 500;
  transition:
    background 80ms ease,
    color 80ms ease;
}

.mc-popover__thinking-btn:hover {
  color: var(--color-text);
  background: var(--color-bg-panel);
}

.mc-popover__thinking-btn.is-active {
  background: var(--color-bg-panel);
  color: var(--color-text-strong);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
}

.mc-popover__search-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.35rem 0.5rem;
  background: var(--color-bg-elevated);
  border-radius: 0.5rem;
}

.mc-popover__search-icon {
  color: var(--color-text-subtle);
  flex-shrink: 0;
}

.mc-popover__search {
  flex: 1;
  border: 0;
  background: transparent;
  color: inherit;
  font-size: 0.88rem;
  outline: none;
  padding: 0;
}

.mc-popover__models {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.mc-popover__model {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
  width: 100%;
  text-align: left;
  border: 0;
  border-radius: 0.4rem;
  background: transparent;
  color: inherit;
  padding: 0.4rem 0.5rem;
  font-size: 0.88rem;
  transition: background 80ms ease;
}

.mc-popover__model:hover {
  background: var(--color-bg-elevated);
}

.mc-popover__model.is-active {
  background: var(--color-user-bg);
  color: var(--color-user-text);
  font-weight: 600;
}

.mc-popover__model-name {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mc-popover__model-provider {
  font-size: 0.78rem;
  color: var(--color-text-subtle);
  text-transform: capitalize;
  flex-shrink: 0;
}

.mc-popover__empty {
  padding: 0.6rem 0.5rem;
  color: var(--color-text-subtle);
  font-size: 0.85rem;
}
</style>
