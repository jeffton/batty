<script setup lang="ts">
import type { ModelOption } from "@/shared/types";
import { computed } from "vue";

const props = defineProps<{
  popoverId: string;
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

const modelGroups = computed(() => {
  const groups = new Map<string, ModelOption[]>();

  for (const model of props.models) {
    const existing = groups.get(model.provider) ?? [];
    existing.push(model);
    groups.set(model.provider, existing);
  }

  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([provider, models]) => ({
      provider,
      models: [...models].sort((left, right) =>
        shortModelLabel(left).localeCompare(shortModelLabel(right)),
      ),
    }));
});

function shortModelLabel(model: Pick<ModelOption, "label">): string {
  return model.label.split(" · ", 1)[0] ?? model.label;
}

function thinkingLabel(value: string): string {
  return value === "xhigh" ? "XHigh" : value.charAt(0).toUpperCase() + value.slice(1);
}
</script>

<template>
  <div :id="props.popoverId" class="model-config-popover" popover>
    <div class="model-config-popover__scroll">
      <section class="model-config-popover__section">
        <div class="model-config-popover__title">Model</div>
        <details
          v-for="group in modelGroups"
          :key="group.provider"
          class="model-config-popover__provider-group"
          :open="group.models.some((model) => model.id === props.currentModelId)"
        >
          <summary class="model-config-popover__provider-summary">{{ group.provider }}</summary>
          <div class="model-config-popover__provider-models">
            <button
              v-for="model in group.models"
              :key="model.id"
              type="button"
              :class="[
                'model-config-popover__option',
                model.id === props.currentModelId ? 'is-active' : '',
              ]"
              @click="emit('setModel', model.id)"
            >
              {{ shortModelLabel(model) }}
            </button>
          </div>
        </details>
      </section>

      <section class="model-config-popover__section">
        <div class="model-config-popover__title">Thinking</div>
        <div class="model-config-popover__thinking-options">
          <button
            v-for="option in props.thinkingOptions"
            :key="option"
            type="button"
            :class="[
              'model-config-popover__option',
              option === props.currentThinkingLevel ? 'is-active' : '',
            ]"
            @click="emit('setThinkingLevel', option)"
          >
            {{ thinkingLabel(option) }}
          </button>
        </div>
      </section>
    </div>

    <button class="model-config-popover__close" type="button" @click="emit('close')">Done</button>
  </div>
</template>

<style scoped>
.model-config-popover {
  width: min(28rem, calc(100vw - 2rem));
  max-height: min(36rem, calc(100dvh - 2rem));
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
  overscroll-behavior: contain;
  margin: 0;
  padding: 0.7rem;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 0.65rem;
  background: rgba(22, 27, 34, 0.98);
  color: inherit;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.38);
}

.model-config-popover::backdrop {
  background: rgba(0, 0, 0, 0.18);
}

.model-config-popover__scroll {
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  padding-right: 0.1rem;
}

.model-config-popover__section {
  display: grid;
  gap: 0.45rem;
}

.model-config-popover__section + .model-config-popover__section {
  margin-top: 0.75rem;
}

.model-config-popover__title {
  font-size: 0.76rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #93a0ad;
}

.model-config-popover__provider-group {
  border: 0;
  border-radius: 0;
  background: transparent;
}

.model-config-popover__provider-summary {
  cursor: pointer;
  list-style: none;
  padding: 0.4rem 0;
  font-weight: 600;
  text-transform: capitalize;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.6rem;
}

.model-config-popover__provider-summary::after {
  content: "▾";
  color: #93a0ad;
  font-size: 0.85rem;
  transition: transform 0.16s ease;
}

.model-config-popover__provider-group:not([open]) .model-config-popover__provider-summary::after {
  transform: rotate(-90deg);
}

.model-config-popover__provider-summary::-webkit-details-marker {
  display: none;
}

.model-config-popover__provider-models,
.model-config-popover__thinking-options {
  display: grid;
  gap: 0.3rem;
  padding: 0 0 0.35rem;
}

.model-config-popover__option {
  width: 100%;
  text-align: left;
  border-radius: 0.4rem;
  border: 1px solid rgba(255, 255, 255, 0.06);
  background: rgba(255, 255, 255, 0.04);
  color: inherit;
  padding: 0.42rem 0.55rem;
}

.model-config-popover__option.is-active {
  border-color: rgba(96, 165, 250, 0.45);
  background: rgba(37, 99, 235, 0.18);
  color: #dbeafe;
}

.model-config-popover__close {
  margin-top: 0.8rem;
  width: 100%;
  border-radius: 0.45rem;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.06);
  color: inherit;
  padding: 0.45rem 0.6rem;
  flex: 0 0 auto;
}

@media (max-width: 900px) {
  .model-config-popover {
    width: min(26rem, calc(100vw - 1rem));
    max-height: calc(100dvh - 1rem);
    padding: 0.6rem;
  }

  .model-config-popover__scroll {
    padding-right: 0;
  }
}
</style>
