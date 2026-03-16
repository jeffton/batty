<script setup lang="ts">
import { computed } from "vue";
import { createEditPreviewLines, parseRenderedDiff } from "@/client/lib/tool-diff";

const props = withDefaults(
  defineProps<{
    diff?: string;
    oldText?: string;
    newText?: string;
    compact?: boolean;
  }>(),
  {
    diff: undefined,
    oldText: undefined,
    newText: undefined,
    compact: false,
  },
);

const lines = computed(() => {
  if (typeof props.diff === "string" && props.diff.trim().length > 0) {
    return parseRenderedDiff(props.diff);
  }

  if (typeof props.oldText === "string" || typeof props.newText === "string") {
    return createEditPreviewLines(props.oldText ?? "", props.newText ?? "");
  }

  return [];
});

const lineNumberWidth = computed(() =>
  Math.max(
    1,
    ...lines.value.flatMap((line) => [line.oldNumber?.length ?? 0, line.newNumber?.length ?? 0]),
  ),
);
</script>

<template>
  <div
    :class="['diff-block', props.compact ? 'diff-block--compact' : '']"
    :style="{ '--diff-line-number-width': `${lineNumberWidth}ch` }"
  >
    <div
      v-for="(line, index) in lines"
      :key="index"
      :class="['diff-block__line', `diff-block__line--${line.kind}`]"
    >
      <span class="diff-block__prefix">{{ line.prefix }}</span>
      <span class="diff-block__line-number">{{ line.oldNumber ?? "" }}</span>
      <span class="diff-block__line-number">{{ line.newNumber ?? "" }}</span>
      <span class="diff-block__content" v-html="line.html" />
    </div>
  </div>
</template>

<style scoped>
.diff-block {
  margin: 0;
  padding: 0;
  border-radius: 0;
  border: 0;
  background: transparent;
  color: var(--color-code-text);
  overflow-x: hidden;
  overflow-y: auto;
}

.diff-block--compact {
  padding: 0.55rem 0.65rem;
}

.diff-block {
  display: grid;
  gap: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.84rem;
  line-height: 1.45;
}

.diff-block__line {
  display: grid;
  grid-template-columns: 1.25ch var(--diff-line-number-width) var(--diff-line-number-width) minmax(
      0,
      1fr
    );
  align-items: start;
  column-gap: 0.75rem;
}

.diff-block__line-number,
.diff-block__prefix {
  color: color-mix(in srgb, var(--color-text-subtle) 78%, transparent);
  text-align: right;
  user-select: none;
}

.diff-block__content {
  min-width: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.diff-block__line--context .diff-block__content,
.diff-block__line--meta .diff-block__content,
.diff-block__line--ellipsis .diff-block__content,
.diff-block__line--ellipsis .diff-block__prefix {
  color: var(--color-text-subtle);
}

.diff-block__line--add {
  background: var(--color-diff-add-bg);
}

.diff-block__line--add .diff-block__prefix,
.diff-block__line--add .diff-block__content {
  color: var(--color-diff-add-text);
}

.diff-block__line--remove {
  background: var(--color-diff-remove-bg);
}

.diff-block__line--remove .diff-block__prefix,
.diff-block__line--remove .diff-block__content {
  color: var(--color-diff-remove-text);
}

.diff-block__content :deep(.diff-block__inline-change) {
  background: var(--color-diff-inline);
  border-radius: 0.2rem;
}
</style>
