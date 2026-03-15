<script setup lang="ts">
import CodeBlock from "@/client/components/CodeBlock.vue";
import DiffBlock from "@/client/components/DiffBlock.vue";
import MarkdownBlock from "@/client/components/MarkdownBlock.vue";
import ToolCallBlock from "@/client/components/ToolCallBlock.vue";
import type { UiContentBlock, UiMessage } from "@/shared/types";

const props = defineProps<{
  message: UiMessage;
}>();

function imageUrl(block: Extract<UiContentBlock, { type: "image" }>): string {
  return `data:${block.mimeType};base64,${block.data}`;
}
</script>

<template>
  <article :class="['message', `message--${props.message.role}`]">
    <div v-if="props.message.role === 'bashExecution'" class="message__body">
      <CodeBlock :code="`$ ${props.message.command}\n${props.message.output}`" language="bash" />
    </div>

    <div v-else-if="props.message.role === 'custom'" class="message__body">
      <div class="message__text">{{ props.message.text }}</div>
    </div>

    <div v-else class="message__body">
      <template
        v-for="(block, index) in props.message.blocks"
        :key="`${props.message.id}-${index}`"
      >
        <MarkdownBlock
          v-if="block.type === 'text' && props.message.role === 'assistant'"
          :text="block.text"
        />
        <CodeBlock
          v-else-if="
            block.type === 'text' &&
            props.message.role === 'toolResult' &&
            props.message.toolName === 'bash'
          "
          :code="block.text"
          language="bash"
          compact
        />
        <div v-else-if="block.type === 'text'" class="message__text">{{ block.text }}</div>
        <img v-else-if="block.type === 'image'" :src="imageUrl(block)" alt="Message attachment" />
        <MarkdownBlock
          v-else-if="block.type === 'thinking'"
          :text="block.thinking"
          variant="thinking"
        />
        <ToolCallBlock
          v-else-if="block.type === 'toolCall'"
          :name="block.name"
          :arguments="block.arguments"
        />
      </template>

      <DiffBlock
        v-if="
          props.message.role === 'toolResult' &&
          props.message.toolName === 'edit' &&
          typeof props.message.details?.diff === 'string'
        "
        :diff="props.message.details.diff"
      />
    </div>
  </article>
</template>

<style scoped>
.message {
  display: grid;
  min-width: 0;
}

.message--assistant,
.message--toolResult,
.message--bashExecution,
.message--custom {
  padding: 0;
  border: 0;
  background: transparent;
}

.message--user {
  padding: 0.55rem 0.7rem;
  border-radius: 0.5rem;
  background: rgba(33, 38, 45, 0.9);
  margin-left: auto;
}

.message__body {
  display: grid;
  gap: 0.45rem;
  min-width: 0;
}

.message__text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.45;
}

img {
  max-width: min(100%, 32rem);
  border-radius: 0.45rem;
}
</style>
