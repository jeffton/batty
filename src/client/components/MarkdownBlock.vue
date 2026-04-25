<script setup lang="ts">
import { computed } from "vue";
import DOMPurify from "dompurify";
import { Marked, marked, type Tokens } from "marked";

const props = withDefaults(
  defineProps<{
    text: string;
    variant?: "default" | "thinking";
  }>(),
  {
    variant: "default",
  },
);

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const renderer = new marked.Renderer();
renderer.link = function (this: typeof renderer, { href, title, tokens }: Tokens.Link): string {
  const titleAttribute = title ? ` title="${escapeAttribute(title)}"` : "";
  return `<a target="_blank" rel="noopener noreferrer" href="${escapeAttribute(href)}"${titleAttribute}>${this.parser.parseInline(tokens)}</a>`;
};

const markdown = new Marked({
  breaks: true,
  gfm: true,
  renderer,
});

const html = computed(() =>
  DOMPurify.sanitize(markdown.parse(props.text) as string, { ADD_ATTR: ["target"] }),
);
</script>

<template>
  <div :class="['markdown-body', `markdown-body--${props.variant}`]" v-html="html" />
</template>

<style scoped>
.markdown-body {
  min-width: 0;
  max-width: 100%;
  overflow-wrap: anywhere;
}

.markdown-body :deep(p) {
  margin: 0 0 0.55rem;
}

.markdown-body :deep(p:last-child) {
  margin-bottom: 0;
}

.markdown-body :deep(pre) {
  margin: 0.55rem 0;
  max-width: 100%;
  padding: 0.7rem 0.8rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
  overflow-x: hidden;
  border-radius: 0.5rem;
  background: var(--color-code-bg);
  border: 1px solid var(--color-code-border);
}

.markdown-body :deep(code) {
  padding: 0.08rem 0.24rem;
  border-radius: 0.28rem;
  background: var(--color-bg-inline-code);
  overflow-wrap: anywhere;
  word-break: break-word;
}

.markdown-body :deep(pre code) {
  padding: 0;
  background: transparent;
  white-space: inherit;
}

.markdown-body :deep(blockquote) {
  margin: 0.55rem 0;
  padding-left: 0.8rem;
  border-left: 2px solid var(--color-border-accent);
  color: var(--color-text-muted);
}

.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  margin: 0.4rem 0 0.55rem;
  padding-left: 1.25rem;
}

.markdown-body :deep(img) {
  max-width: 100%;
  border-radius: 0.5rem;
}

.markdown-body :deep(table) {
  display: block;
  max-width: 100%;
  overflow-x: auto;
}

.markdown-body--thinking {
  color: var(--color-text-subtle);
  font-style: italic;
  opacity: 0.94;
}

.markdown-body--thinking :deep(em) {
  font-style: normal;
}
</style>
