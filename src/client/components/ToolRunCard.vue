<script setup lang="ts">
import type { ActiveToolRun, UiContentBlock } from "@/shared/types";

const props = defineProps<{
  tool: ActiveToolRun;
}>();

function imageUrl(block: Extract<UiContentBlock, { type: "image" }>): string {
  return `data:${block.mimeType};base64,${block.data}`;
}
</script>

<template>
  <div class="tool-card panel">
    <div class="tool-card__header">
      <strong>{{ props.tool.toolName }}</strong>
      <span :class="props.tool.isError ? 'tool-error' : 'tool-ok'">{{
        props.tool.isError ? "error" : "running"
      }}</span>
    </div>
    <pre class="tool-card__args">{{ JSON.stringify(props.tool.args, null, 2) }}</pre>
    <div
      v-for="(block, index) in props.tool.blocks"
      :key="`${props.tool.toolCallId}-${index}`"
      class="tool-card__block"
    >
      <pre v-if="block.type === 'text'">{{ block.text }}</pre>
      <img v-else-if="block.type === 'image'" :src="imageUrl(block)" alt="Tool output" />
      <pre v-else-if="block.type === 'thinking'">{{ block.thinking }}</pre>
      <pre v-else-if="block.type === 'toolCall'"
        >{{ block.name }} {{ JSON.stringify(block.arguments, null, 2) }}</pre
      >
    </div>
  </div>
</template>

<style scoped>
.tool-card {
  padding: 0.75rem;
  display: grid;
  gap: 0.55rem;
}

.tool-card__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.tool-card__args,
.tool-card__block pre {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: #d1d5db;
  background: rgba(13, 17, 23, 0.75);
  border-radius: 0.55rem;
  padding: 0.7rem 0.75rem;
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.tool-card__block img {
  width: min(100%, 28rem);
  border-radius: 0.55rem;
}

.tool-ok {
  color: #86efac;
}

.tool-error {
  color: #fca5a5;
}
</style>
