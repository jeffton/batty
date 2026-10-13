<script setup lang="ts">
defineProps<{ label: string }>();
</script>

<template>
  <div class="settings-popover__inline">
    <label class="settings-popover__field">
      <span>{{ label }}</span>
      <slot />
    </label>
    <slot name="action" />
  </div>
</template>
