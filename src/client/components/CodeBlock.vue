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
  padding: 0.7rem 0.8rem;
  border-radius: 0.45rem;
  border: 1px solid rgba(255, 255, 255, 0.07);
  background: rgba(17, 21, 28, 0.92);
  color: #dbe4ee;
  line-height: 1.45;
}

.code-block--compact {
  padding: 0.55rem 0.65rem;
}

.code-block--insert {
  background: rgba(22, 101, 52, 0.22);
  border-color: rgba(74, 222, 128, 0.22);
}

.code-block--delete {
  background: rgba(127, 29, 29, 0.22);
  border-color: rgba(248, 113, 113, 0.2);
}

.code-block :deep(.hljs-comment),
.code-block :deep(.hljs-quote) {
  color: #7f8ea3;
}

.code-block :deep(.hljs-keyword),
.code-block :deep(.hljs-selector-tag),
.code-block :deep(.hljs-literal),
.code-block :deep(.hljs-section),
.code-block :deep(.hljs-link) {
  color: #d2a8ff;
}

.code-block :deep(.hljs-string),
.code-block :deep(.hljs-attr),
.code-block :deep(.hljs-template-tag),
.code-block :deep(.hljs-template-variable) {
  color: #a5d6ff;
}

.code-block :deep(.hljs-number),
.code-block :deep(.hljs-symbol),
.code-block :deep(.hljs-bullet),
.code-block :deep(.hljs-variable),
.code-block :deep(.hljs-literal) {
  color: #f9c97c;
}

.code-block :deep(.hljs-title),
.code-block :deep(.hljs-title.class_),
.code-block :deep(.hljs-title.function_) {
  color: #86efac;
}

.code-block :deep(.hljs-tag),
.code-block :deep(.hljs-name),
.code-block :deep(.hljs-selector-id),
.code-block :deep(.hljs-selector-class) {
  color: #7dd3fc;
}
</style>
