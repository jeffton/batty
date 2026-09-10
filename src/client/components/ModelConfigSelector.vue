<script setup lang="ts">
import { Bot } from "@lucide/vue";
import ModelConfigPopover from "@/client/components/ModelConfigPopover.vue";
import type { ModelOption } from "@/shared/types";

const props = withDefaults(
  defineProps<{
    popoverId: string;
    anchorName: string;
    models: ModelOption[];
    currentModelId?: string;
    currentThinkingLevel: string;
    thinkingOptions: string[];
    disabled?: boolean;
    placement?: "down" | "up";
    modelLabel: string;
    effortLabel: string;
    ariaLabel?: string;
    compact?: boolean;
  }>(),
  {
    ariaLabel: "Model and thinking",
  },
);

const emit = defineEmits<{
  refreshModels: [];
  setModel: [modelId: string];
  setThinkingLevel: [thinkingLevel: string];
}>();
</script>

<template>
  <div :class="['model-config-selector', props.compact ? 'model-config-selector--compact' : '']">
    <button
      class="model-config-selector__button"
      type="button"
      :style="{ 'anchor-name': props.anchorName }"
      :disabled="props.disabled"
      :popovertarget="props.popoverId"
      :title="`${props.modelLabel} · ${props.effortLabel}`"
      :aria-label="props.ariaLabel"
      @click="emit('refreshModels')"
    >
      <Bot :size="17" class="model-config-selector__icon" />
      <span class="model-config-selector__info">
        <span class="model-config-selector__model-label">{{ props.modelLabel }}</span>
        <span class="model-config-selector__effort-label">{{ props.effortLabel }}</span>
      </span>
    </button>

    <ModelConfigPopover
      :popover-id="props.popoverId"
      :anchor-name="props.anchorName"
      :models="props.models"
      :current-model-id="props.currentModelId"
      :current-thinking-level="props.currentThinkingLevel"
      :thinking-options="props.thinkingOptions"
      :disabled="props.disabled"
      :placement="props.placement"
      @set-model="emit('setModel', $event)"
      @set-thinking-level="emit('setThinkingLevel', $event)"
    />
  </div>
</template>

<style scoped>
.model-config-selector {
  display: contents;
}

.model-config-selector__button {
  width: 100%;
  min-height: 2.5rem;
  padding: 0 0.55rem;
  border: 0;
  border-radius: 0.5rem;
  background: transparent;
  color: var(--color-text-muted);
  display: inline-grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  transition:
    background 80ms ease,
    color 80ms ease;
}

.model-config-selector--compact .model-config-selector__button {
  width: auto;
  max-width: min(12rem, 44vw);
}

@media (hover: hover) {
  .model-config-selector__button:hover:not(:disabled) {
    background: var(--color-bg-elevated);
    color: var(--color-text);
  }
}

.model-config-selector__button:disabled {
  opacity: 0.4;
}

.model-config-selector__icon {
  display: block;
}

.model-config-selector__info {
  min-width: 0;
  display: grid;
  gap: 0.05rem;
  text-align: left;
  line-height: 1.05;
}

.model-config-selector__model-label,
.model-config-selector__effort-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-config-selector__model-label {
  color: var(--color-text-strong);
  font-size: 0.8rem;
  font-weight: 600;
}

.model-config-selector__effort-label {
  color: var(--color-text-subtle);
  font-size: 0.7rem;
}
</style>
