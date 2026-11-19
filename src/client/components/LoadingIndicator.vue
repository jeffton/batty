<script setup lang="ts">
defineProps<{ label?: string; large?: boolean }>();
</script>

<template>
  <span class="loading-indicator" :class="{ 'loading-indicator--idle': !label }">
    <span class="loading-indicator__status" role="status" :aria-label="label">
      <span class="loading-indicator__text">{{ label }}</span>
      <span
        v-if="label"
        class="spinner"
        :class="{ 'loading-indicator__compact': !large }"
        aria-hidden="true"
      />
    </span>
  </span>
</template>

<style scoped>
.loading-indicator,
.loading-indicator__status {
  display: inline-flex;
  align-items: center;
  vertical-align: middle;
}

.loading-indicator.loading-indicator--idle {
  position: absolute;
  width: 0;
  height: 0;
  min-height: 0;
  padding: 0;
  pointer-events: none;
}

.loading-indicator__text {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.loading-indicator__compact {
  width: 1rem;
  height: 1rem;
  border-width: 2px;
}

@media (prefers-reduced-motion: reduce) {
  .loading-indicator .spinner {
    animation: none;
  }
}
</style>
