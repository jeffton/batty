<script setup lang="ts">
import { Pencil, X } from "@lucide/vue";

defineProps<{
  title: string;
  status: string;
  connected: boolean;
  expanded: boolean;
  disabled?: boolean;
}>();

defineEmits<{ toggle: [] }>();
</script>

<template>
  <div class="settings-popover__editor">
    <div class="settings-popover__item-top">
      <div class="settings-popover__item-meta">
        <div class="settings-popover__group-title">{{ title }}</div>
        <div
          class="settings-popover__help"
          :class="{ 'settings-popover__status--connected': connected }"
        >
          {{ status }}
        </div>
      </div>
      <button
        class="settings-popover__action"
        type="button"
        :aria-label="`${expanded ? 'Close' : 'Edit'} ${title}`"
        :disabled="disabled"
        :aria-expanded="expanded"
        @click="$emit('toggle')"
      >
        <component :is="expanded ? X : Pencil" :size="16" aria-hidden="true" />
      </button>
    </div>
    <slot v-if="expanded" />
  </div>
</template>
