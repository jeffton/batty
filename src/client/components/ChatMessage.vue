<script setup lang="ts">
import CodeBlock from "@/client/components/CodeBlock.vue";
import MarkdownBlock from "@/client/components/MarkdownBlock.vue";
import ToolCallBlock from "@/client/components/ToolCallBlock.vue";
import { formatShortTime } from "@/client/lib/formatting";
import type { UiContentBlock, UiMessage } from "@/shared/types";

const props = defineProps<{
  message: UiMessage;
}>();

function imageUrl(block: Extract<UiContentBlock, { type: "image" }>): string {
  return `data:${block.mimeType};base64,${block.data}`;
}

function messageLabel(message: UiMessage): string {
  if (message.role === "user") {
    return "You";
  }
  if (message.role === "assistant") {
    return "Pi";
  }
  if (message.role === "toolResult") {
    return message.toolName;
  }
  if (message.role === "bashExecution") {
    return "Bash";
  }
  return message.customType;
}
</script>

<template>
  <article :class="['message', `message--${props.message.role}`]">
    <header class="message__header">
      <strong>{{ messageLabel(props.message) }}</strong>
      <span class="muted">{{ formatShortTime(props.message.timestamp) }}</span>
    </header>

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
        <div v-else-if="block.type === 'text'" class="message__text">{{ block.text }}</div>
        <img v-else-if="block.type === 'image'" :src="imageUrl(block)" alt="Message attachment" />
        <div v-else-if="block.type === 'thinking'" class="thinking-block">{{ block.thinking }}</div>
        <ToolCallBlock
          v-else-if="block.type === 'toolCall'"
          :name="block.name"
          :arguments="block.arguments"
        />
      </template>
    </div>
  </article>
</template>

<style scoped>
.message {
  display: grid;
  gap: 0.35rem;
  padding: 0.55rem 0.7rem;
  border-radius: 0.5rem;
  border: 1px solid rgba(255, 255, 255, 0.05);
}

.message--assistant,
.message--toolResult,
.message--bashExecution,
.message--custom {
  background: rgba(22, 27, 34, 0.5);
}

.message--user {
  background: rgba(33, 38, 45, 0.9);
  margin-left: auto;
}

.message--toolResult {
  border-color: rgba(248, 113, 113, 0.2);
  background: rgba(127, 29, 29, 0.12);
}

.message__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  font-size: 0.78rem;
}

.message__body {
  display: grid;
  gap: 0.45rem;
  min-width: 0;
}

.message__text,
.thinking-block {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.message__text {
  line-height: 1.45;
}

img {
  max-width: min(100%, 32rem);
  border-radius: 0.45rem;
}

.thinking-block {
  color: #94a3b8;
  font-style: italic;
  opacity: 0.9;
}
</style>
