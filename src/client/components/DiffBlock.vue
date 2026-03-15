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
  padding: 0.7rem 0.8rem;
  border-radius: 0.45rem;
  border: 1px solid rgba(255, 255, 255, 0.07);
  background: rgba(17, 21, 28, 0.92);
  color: #dbe4ee;
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
  color: rgba(148, 163, 184, 0.78);
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
.diff-block__line--ellipsis .diff-block__content {
  color: #94a3b8;
}

.diff-block__line--add {
  background: rgba(34, 197, 94, 0.08);
}

.diff-block__line--add .diff-block__prefix,
.diff-block__line--add .diff-block__content {
  color: #86efac;
}

.diff-block__line--remove {
  background: rgba(248, 113, 113, 0.08);
}

.diff-block__line--remove .diff-block__prefix,
.diff-block__line--remove .diff-block__content {
  color: #fca5a5;
}

.diff-block__line--ellipsis .diff-block__prefix {
  color: #94a3b8;
}

.diff-block__content :deep(.diff-block__inline-change) {
  background: rgba(255, 255, 255, 0.14);
  border-radius: 0.2rem;
}
</style>
