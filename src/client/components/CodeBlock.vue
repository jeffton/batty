<script setup lang="ts">
import { computed } from "vue";
import { highlightCode } from "@/client/lib/code-format";

const props = withDefaults(
  defineProps<{
    code: string;
    language?: string;
    tone?: "neutral" | "insert" | "delete";
    compact?: boolean;
  }>(),
  {
    language: undefined,
    tone: "neutral",
    compact: false,
  },
);

const highlighted = computed(() => highlightCode(props.code, props.language));
</script>

<template>
  <pre
    :class="['code-block', `code-block--${props.tone}`, props.compact ? 'code-block--compact' : '']"
  ><code class="hljs" v-html="highlighted" /></pre>
</template>

<style scoped>
.code-block {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
  overflow-x: hidden;
  padding: 0;
  border-radius: 0;
  border: 0;
  background: transparent;
  color: var(--color-code-text);
  line-height: 1.45;
}

.code-block--compact {
  padding: 0.55rem 0.65rem;
}

.code-block--insert {
  background: color-mix(in srgb, var(--color-success) 16%, transparent);
}

.code-block--delete {
  background: color-mix(in srgb, var(--color-error) 16%, transparent);
}

.code-block :deep(.hljs-comment),
.code-block :deep(.hljs-quote) {
  color: var(--color-code-comment);
}

.code-block :deep(.hljs-keyword),
.code-block :deep(.hljs-selector-tag),
.code-block :deep(.hljs-literal),
.code-block :deep(.hljs-section),
.code-block :deep(.hljs-link) {
  color: var(--color-code-keyword);
}

.code-block :deep(.hljs-string),
.code-block :deep(.hljs-attr),
.code-block :deep(.hljs-template-tag),
.code-block :deep(.hljs-template-variable) {
  color: var(--color-code-string);
}

.code-block :deep(.hljs-number),
.code-block :deep(.hljs-symbol),
.code-block :deep(.hljs-bullet),
.code-block :deep(.hljs-variable),
.code-block :deep(.hljs-literal) {
  color: var(--color-code-number);
}

.code-block :deep(.hljs-title),
.code-block :deep(.hljs-title.class_),
.code-block :deep(.hljs-title.function_) {
  color: var(--color-code-title);
}

.code-block :deep(code),
.code-block :deep(.hljs) {
  white-space: inherit;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.code-block :deep(.hljs-tag),
.code-block :deep(.hljs-name),
.code-block :deep(.hljs-selector-id),
.code-block :deep(.hljs-selector-class) {
  color: var(--color-code-tag);
}
</style>
