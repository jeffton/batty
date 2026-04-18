<script setup lang="ts">
const props = defineProps<{
  options: string[];
  current: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  change: [value: string];
}>();

function thinkingLabel(value: string): string {
  return value === "xhigh" ? "XHigh" : value.charAt(0).toUpperCase() + value.slice(1);
}
</script>

<template>
  <div class="thinking-picker" :class="props.disabled ? 'is-disabled' : ''">
    <button
      v-for="option in props.options"
      :key="option"
      type="button"
      :disabled="props.disabled"
      :class="['thinking-picker__btn', option === props.current ? 'is-active' : '']"
      @click="emit('change', option)"
    >
      {{ thinkingLabel(option) }}
    </button>
  </div>
</template>

<style scoped>
.thinking-picker {
  display: flex;
  gap: 0.25rem;
  padding: 0.15rem;
  background: var(--color-bg-elevated);
  border-radius: 0.45rem;
}

.thinking-picker.is-disabled {
  opacity: 0.6;
}

.thinking-picker__btn {
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

@media (hover: hover) {
  .thinking-picker__btn:hover:not(:disabled):not(.is-active) {
    color: var(--color-text);
    background: var(--color-bg-hover);
  }
}

.thinking-picker__btn.is-active {
  background: var(--color-user-bg);
  color: var(--color-user-text);
  font-weight: 600;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
}

.thinking-picker__btn:disabled {
  cursor: default;
}
</style>
