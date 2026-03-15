<script setup lang="ts">
import type { ModelOption } from "@/shared/types";
import { X } from "lucide-vue-next";
import { computed } from "vue";

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
  <div
    :id="props.popoverId"
    class="model-config-popover"
    :style="{ 'position-anchor': props.anchorName }"
    popover="auto"
  >
    <button
      class="model-config-popover__close"
      type="button"
      aria-label="Close model selector"
      title="Close"
      @click="emit('close')"
    >
      <X :size="16" />
    </button>

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
  </div>
</template>

<style scoped>
.model-config-popover {
  position: relative;
  display: none;
}

.model-config-popover:popover-open {
  position: absolute;
  top: calc(anchor(bottom) + 0.35rem);
  right: anchor(right);
  left: auto;
  width: min(28rem, calc(100vw - 2rem));
  max-height: min(36rem, calc(100dvh - 2rem));
  display: block;
  overscroll-behavior: contain;
  margin: 0;
  padding: 0.7rem;
  border: 1px solid var(--color-border-strong);
  border-radius: 0.65rem;
  background: var(--color-bg-overlay);
  color: inherit;
  box-shadow: var(--color-shadow-popover);
}

.model-config-popover::backdrop {
  background: var(--color-backdrop);
}

.model-config-popover__scroll {
  min-height: 0;
  max-height: calc(min(36rem, calc(100dvh - 2rem)) - 1.4rem);
  overflow: auto;
  overscroll-behavior: contain;
  padding-top: 1.35rem;
  padding-right: 0.1rem;
}

.model-config-popover__close {
  position: absolute;
  top: 0.55rem;
  right: 0.55rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  border-radius: 999px;
  border: 1px solid var(--color-border-strong);
  background: var(--color-bg-elevated-soft);
  color: var(--color-text);
  cursor: pointer;
  z-index: 1;
  transition:
    background-color 140ms ease,
    border-color 140ms ease,
    color 140ms ease,
    transform 140ms ease;
}

.model-config-popover__close:hover {
  background: var(--color-bg-elevated);
}

.model-config-popover__close:active {
  transform: translateY(1px);
}

.model-config-popover__close:focus-visible,
.model-config-popover__provider-summary:focus-visible,
.model-config-popover__option:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--color-info) 70%, transparent);
  outline-offset: 2px;
}

.model-config-popover__section {
  display: grid;
  gap: 0.45rem;
}

.model-config-popover__section + .model-config-popover__section {
  margin-top: 0.75rem;
}

.model-config-popover__title,
.model-config-popover__provider-summary::before {
  color: var(--color-text-subtle);
}

.model-config-popover__title {
  font-size: 0.76rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
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
  justify-content: flex-start;
  gap: 0.55rem;
  transition:
    background-color 140ms ease,
    color 140ms ease,
    transform 140ms ease;
}

.model-config-popover__provider-summary:hover {
  color: var(--color-text-strong);
}

.model-config-popover__provider-summary:active,
.model-config-popover__option:active {
  transform: translateY(1px);
}

.model-config-popover__provider-summary::-webkit-details-marker {
  display: none;
}

.model-config-popover__provider-summary::marker {
  content: "";
}

.model-config-popover__provider-summary::before {
  content: "▾";
  font-size: 1.15rem;
  line-height: 1;
  width: 1rem;
  flex: 0 0 1rem;
  text-align: center;
  transition: transform 0.16s ease;
}

.model-config-popover__provider-group:not([open]) .model-config-popover__provider-summary::before {
  transform: rotate(-90deg);
}

.model-config-popover__provider-models,
.model-config-popover__thinking-options {
  display: grid;
  gap: 0.3rem;
  padding: 0 0 0.35rem;
}

.model-config-popover__option {
  width: 100%;
  cursor: pointer;
  text-align: left;
  border-radius: 0.4rem;
  border: 1px solid var(--color-border-soft);
  background: var(--color-bg-elevated-soft);
  color: inherit;
  padding: 0.42rem 0.55rem;
  transition:
    background-color 140ms ease,
    border-color 140ms ease,
    color 140ms ease,
    transform 140ms ease;
}

.model-config-popover__option:hover {
  background: var(--color-bg-elevated);
}

.model-config-popover__option.is-active {
  border-color: color-mix(in srgb, var(--color-info) 45%, transparent);
  background: var(--color-info-soft);
  color: var(--color-text-strong);
}

.model-config-popover__option.is-active:hover {
  background: var(--color-info-soft-strong);
}
</style>
