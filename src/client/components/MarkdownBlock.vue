<script setup lang="ts">
import { computed } from "vue";
import DOMPurify from "dompurify";
import { marked } from "marked";

const props = defineProps<{
  text: string;
}>();

marked.setOptions({
  breaks: true,
  gfm: true,
});

const html = computed(() => DOMPurify.sanitize(marked.parse(props.text) as string));
</script>

<template>
  <div class="markdown-body" v-html="html" />
</template>

<style scoped>
.markdown-body :deep(p) {
  margin: 0 0 0.75rem;
}

.markdown-body :deep(p:last-child) {
  margin-bottom: 0;
}

.markdown-body :deep(pre) {
  margin: 0.75rem 0;
  padding: 0.85rem 1rem;
  overflow-x: auto;
  border-radius: 0.85rem;
  background: rgba(2, 6, 23, 0.85);
  border: 1px solid rgba(148, 163, 184, 0.12);
}

.markdown-body :deep(code) {
  padding: 0.1rem 0.3rem;
  border-radius: 0.4rem;
  background: rgba(15, 23, 42, 0.85);
}

.markdown-body :deep(pre code) {
  padding: 0;
  background: transparent;
}

.markdown-body :deep(blockquote) {
  margin: 0.75rem 0;
  padding-left: 1rem;
  border-left: 3px solid rgba(96, 165, 250, 0.65);
  color: #b8c7db;
}

.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  margin: 0.5rem 0 0.75rem 1.15rem;
  padding: 0;
}

.markdown-body :deep(img) {
  max-width: 100%;
  border-radius: 0.85rem;
}
</style>
