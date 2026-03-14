<script setup lang="ts">
import CodeBlock from "@/client/components/CodeBlock.vue";
import MarkdownBlock from "@/client/components/MarkdownBlock.vue";
import ToolCallBlock from "@/client/components/ToolCallBlock.vue";
import type { ActiveToolRun, UiContentBlock } from "@/shared/types";

const props = defineProps<{
  tool: ActiveToolRun;
}>();

function imageUrl(block: Extract<UiContentBlock, { type: "image" }>): string {
  return `data:${block.mimeType};base64,${block.data}`;
}
</script>

<template>
  <div class="tool-card">
    <div class="tool-card__header">
      <strong>{{ props.tool.toolName }}</strong>
      <span :class="props.tool.isError ? 'tool-error' : 'tool-ok'">{{
        props.tool.isError ? "error" : "running"
      }}</span>
    </div>

    <ToolCallBlock :name="props.tool.toolName" :arguments="props.tool.args" compact />

    <div
      v-for="(block, index) in props.tool.blocks"
      :key="`${props.tool.toolCallId}-${index}`"
      class="tool-card__block"
    >
      <CodeBlock
        v-if="block.type === 'text' && props.tool.toolName === 'bash'"
        :code="block.text"
        language="bash"
        compact
      />
      <div v-else-if="block.type === 'text'" class="tool-card__text">{{ block.text }}</div>
      <img v-else-if="block.type === 'image'" :src="imageUrl(block)" alt="Tool output" />
      <MarkdownBlock
        v-else-if="block.type === 'thinking'"
        :text="block.thinking"
        variant="thinking"
      />
      <ToolCallBlock
        v-else-if="block.type === 'toolCall'"
        :name="block.name"
        :arguments="block.arguments"
        compact
      />
    </div>
  </div>
</template>

<style scoped>
.tool-card {
  padding: 0.5rem 0.65rem;
  display: grid;
  gap: 0.45rem;
  border-radius: 0.5rem;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(31, 36, 45, 0.82);
}

.tool-card__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.75rem;
  font-size: 0.78rem;
}

.tool-card__text {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: #cbd5e1;
  line-height: 1.45;
}

.tool-card img {
  width: min(100%, 28rem);
  border-radius: 0.45rem;
}

.tool-ok {
  color: #86efac;
}

.tool-error {
  color: #fca5a5;
}
</style>
