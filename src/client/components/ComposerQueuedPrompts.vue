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
  return prompt.kind === "steer" ? "steering" : "queued";
}
</script>

<template>
  <div v-if="props.prompts?.length" class="composer-queue">
    <div
      v-for="prompt in props.prompts"
      :key="`${prompt.kind}-${prompt.index}`"
      :class="[
        'composer-queue__item',
        prompt.kind === 'steer' ? 'composer-queue__item--steer' : 'composer-queue__item--follow-up',
      ]"
    >
      <Compass v-if="prompt.kind === 'steer'" class="composer-queue__icon" :size="17" />
      <ListOrdered v-else class="composer-queue__icon" :size="17" />
      <span class="composer-queue__text">{{ prompt.text }}</span>
      <button
        class="composer-queue__remove"
        type="button"
        :aria-label="`Remove ${queuedPromptLabel(prompt)} prompt`"
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
}

.composer-queue__item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.55rem;
  padding: 0.5rem calc(var(--safe-area-right) + 0.45rem) 0.5rem calc(var(--safe-area-left) + 0.8rem);
  border-block: 1px solid transparent;
}

.composer-queue__item--follow-up {
  border-color: oklch(0.55 0.15 175 / 0.18);
  background: var(--color-accent-soft);
}

.composer-queue__item--steer {
  border-color: oklch(0.65 0.16 75 / 0.18);
  background: var(--color-warning-soft);
}

.composer-queue__icon {
  color: var(--color-text-muted);
}

.composer-queue__item--follow-up .composer-queue__icon {
  color: var(--color-accent-strong);
}

.composer-queue__item--steer .composer-queue__icon {
  color: var(--color-warning);
}

.composer-queue__text {
  min-width: 0;
  overflow: hidden;
  color: var(--color-text);
  font-family: var(--font-family-mono);
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
