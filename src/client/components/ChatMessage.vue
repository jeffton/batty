<script setup lang="ts">
import MarkdownBlock from "@/client/components/MarkdownBlock.vue";
import type { UiContentBlock, UiMessage } from "@/shared/types";

const props = defineProps<{
  message: UiMessage;
}>();

function imageUrl(block: Extract<UiContentBlock, { type: "image" }>): string {
  return `data:${block.mimeType};base64,${block.data}`;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
</script>

<template>
  <article :class="['message', `message--${props.message.role}`]">
    <header class="message__header">
      <strong>
        {{
          props.message.role === "user"
            ? "You"
            : props.message.role === "assistant"
              ? "Pi"
              : props.message.role === "toolResult"
                ? props.message.toolName
                : props.message.role === "bashExecution"
                  ? "Bash"
                  : props.message.customType
        }}
      </strong>
      <span class="muted">{{ formatTime(props.message.timestamp) }}</span>
    </header>

    <div v-if="props.message.role === 'bashExecution'" class="message__body">
      <pre><code>$ {{ props.message.command }}
{{ props.message.output }}</code></pre>
    </div>

    <div v-else-if="props.message.role === 'custom'" class="message__body">
      <pre>{{ props.message.text }}</pre>
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
        <pre v-else-if="block.type === 'text'">{{ block.text }}</pre>
        <img v-else-if="block.type === 'image'" :src="imageUrl(block)" alt="Message attachment" />
        <details v-else-if="block.type === 'thinking'" class="thinking-block">
          <summary>Thinking</summary>
          <pre>{{ block.thinking }}</pre>
        </details>
        <pre v-else-if="block.type === 'toolCall'"
          >{{ block.name }} {{ JSON.stringify(block.arguments, null, 2) }}</pre
        >
      </template>
    </div>
  </article>
</template>

<style scoped>
.message {
  display: grid;
  gap: 0.5rem;
  padding: 0.8rem 0.9rem;
  border-radius: 0.7rem;
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.message--assistant,
.message--toolResult,
.message--bashExecution,
.message--custom {
  background: rgba(22, 27, 34, 0.82);
}

.message--user {
  background: rgba(33, 38, 45, 0.95);
  margin-left: auto;
}

.message__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.message__body {
  display: grid;
  gap: 0.65rem;
}

pre {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  padding: 0.7rem 0.8rem;
  border-radius: 0.55rem;
  background: rgba(13, 17, 23, 0.72);
  border: 1px solid rgba(255, 255, 255, 0.06);
}

img {
  max-width: min(100%, 32rem);
  border-radius: 0.6rem;
}

.thinking-block summary {
  cursor: pointer;
  color: #d1d5db;
  margin-bottom: 0.45rem;
}
</style>
