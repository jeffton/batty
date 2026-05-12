<script setup lang="ts">
export interface ToolCallMetaEntry {
  key: string;
  value: string;
}

const props = withDefaults(
  defineProps<{
    entries: ToolCallMetaEntry[];
    inline?: boolean;
  }>(),
  {
    inline: false,
  },
);
</script>

<template>
  <div
    v-if="props.entries.length > 0"
    :class="['tool-call__meta', props.inline ? 'tool-call__meta--read' : '']"
  >
    <div
      v-for="entry in props.entries"
      :key="entry.key"
      :class="props.inline ? 'tool-call__meta-chip' : 'tool-call__meta-row'"
    >
      <span class="tool-call__meta-key">{{ entry.key }}</span>
      <code class="tool-call__meta-value">{{ entry.value }}</code>
    </div>
  </div>
</template>

<style scoped>
.tool-call__meta {
  display: grid;
  gap: 0.4rem;
}

.tool-call__meta--read {
  display: flex;
  gap: 0.6rem 1rem;
  flex-wrap: wrap;
  align-items: center;
}

.tool-call__meta-row,
.tool-call__meta-chip {
  display: flex;
  align-items: baseline;
  gap: 0.45rem;
  flex-wrap: wrap;
}

.tool-call__meta-key {
  color: var(--color-text-subtle);
  font-size: 0.78rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.tool-call__meta-value {
  color: var(--color-info);
  background: var(--color-bg-inline-code);
  border-radius: 0.2rem;
  padding: 0.12rem 0.35rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
