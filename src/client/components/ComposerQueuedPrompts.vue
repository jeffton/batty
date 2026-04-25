<script setup lang="ts">
import { Compass, ListOrdered, X } from "lucide-vue-next";
import type { QueuedPrompt } from "@/shared/types";

const props = defineProps<{
  disabled?: boolean;
  prompts?: QueuedPrompt[];
}>();

const emit = defineEmits<{
  remove: [prompt: QueuedPrompt];
}>();

function queuedPromptLabel(prompt: QueuedPrompt): string {
  return prompt.kind === "steer" ? "Steering" : "Queued";
}
</script>

<template>
  <div v-if="props.prompts?.length" class="composer-queue">
    <div
      v-for="prompt in props.prompts"
      :key="`${prompt.kind}-${prompt.index}`"
      class="composer-queue__item"
    >
      <Compass v-if="prompt.kind === 'steer'" class="composer-queue__icon" :size="17" />
      <ListOrdered v-else class="composer-queue__icon" :size="17" />
      <div class="composer-queue__body">
        <span class="composer-queue__label">{{ queuedPromptLabel(prompt) }}</span>
        <span class="composer-queue__text">{{ prompt.text }}</span>
      </div>
      <button
        class="composer-queue__remove"
        type="button"
        :aria-label="`Remove ${queuedPromptLabel(prompt).toLowerCase()} prompt`"
        :disabled="props.disabled"
        @click="emit('remove', prompt)"
      >
        <X :size="16" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.composer-queue {
  display: grid;
  gap: 0.35rem;
  padding: 0 calc(var(--safe-area-right) + 0.8rem) 0 calc(var(--safe-area-left) + 0.8rem);
}

.composer-queue__item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.5rem;
  padding: 0.45rem 0.5rem;
  border: 1px solid var(--color-border-soft);
  border-radius: 0.65rem;
  background: var(--color-bg-elevated);
}

.composer-queue__icon {
  color: var(--color-text-muted);
}

.composer-queue__body {
  min-width: 0;
  display: grid;
  gap: 0.05rem;
}

.composer-queue__label {
  color: var(--color-text-muted);
  font-size: 0.72rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.composer-queue__text {
  overflow: hidden;
  color: var(--color-text);
  font-size: 0.86rem;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.composer-queue__remove {
  width: 2rem;
  height: 2rem;
  padding: 0;
  border: 0;
  border-radius: 0.45rem;
  background: transparent;
  color: var(--color-text-muted);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition:
    background 80ms ease,
    color 80ms ease;
}

@media (hover: hover) {
  .composer-queue__remove:hover:not(:disabled) {
    background: var(--color-bg-panel-strong);
    color: var(--color-text);
  }
}

.composer-queue__remove:disabled {
  opacity: 0.4;
}
</style>
