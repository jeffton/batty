<script setup lang="ts">
import { computed } from "vue";
import DOMPurify from "dompurify";
import { marked } from "marked";

const props = withDefaults(
  defineProps<{
    text: string;
    variant?: "default" | "thinking";
  }>(),
  {
    variant: "default",
  },
);

marked.setOptions({
  breaks: true,
  gfm: true,
});

const html = computed(() => DOMPurify.sanitize(marked.parse(props.text) as string));
</script>

<template>
  <div :class="['markdown-body', `markdown-body--${props.variant}`]" v-html="html" />
</template>

<style scoped>
.markdown-body {
  min-width: 0;
}

.markdown-body :deep(p) {
  margin: 0 0 0.55rem;
}

.markdown-body :deep(p:last-child) {
  margin-bottom: 0;
}

.markdown-body :deep(pre) {
  margin: 0.55rem 0;
  padding: 0.7rem 0.8rem;
  overflow-x: auto;
  border-radius: 0.5rem;
  background: rgba(2, 6, 23, 0.72);
  border: 1px solid rgba(148, 163, 184, 0.1);
}

.markdown-body :deep(code) {
  padding: 0.08rem 0.24rem;
  border-radius: 0.28rem;
  background: rgba(15, 23, 42, 0.72);
}

.markdown-body :deep(pre code) {
  padding: 0;
  background: transparent;
}

.markdown-body :deep(blockquote) {
  margin: 0.55rem 0;
  padding-left: 0.8rem;
  border-left: 2px solid rgba(96, 165, 250, 0.5);
  color: #b8c7db;
}

.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  margin: 0.4rem 0 0.55rem 1rem;
  padding: 0;
}

.markdown-body :deep(img) {
  max-width: 100%;
  border-radius: 0.5rem;
}

.markdown-body--thinking {
  color: #94a3b8;
  opacity: 0.94;
}

.markdown-body--thinking :deep(em) {
  font-style: normal;
}

.markdown-body--thinking :deep(strong) {
  color: #c6d2df;
}
</style>
