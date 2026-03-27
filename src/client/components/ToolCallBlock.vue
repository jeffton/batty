<script setup lang="ts">
import { Check, CircleAlert, LoaderCircle } from "lucide-vue-next";
import { computed, ref } from "vue";
import CodeBlock from "@/client/components/CodeBlock.vue";
import DiffBlock from "@/client/components/DiffBlock.vue";
import MarkdownBlock from "@/client/components/MarkdownBlock.vue";
import { formatValue, languageFromPath } from "@/client/lib/code-format";
import { createTailView } from "@/client/lib/tool-output";
import { hasToolResultContent } from "@/client/lib/transcript";
import type { ToolExecutionDetails, UiContentBlock } from "@/shared/types";

const OUTPUT_TAIL_LINE_COUNT = 20;

const props = withDefaults(
  defineProps<{
    name: string;
    arguments: Record<string, unknown>;
    compact?: boolean;
    status?: "running" | "success" | "error";
    resultBlocks?: UiContentBlock[];
    resultDetails?: ToolExecutionDetails;
  }>(),
  {
    compact: false,
    status: undefined,
    resultBlocks: () => [],
    resultDetails: undefined,
  },
);

const isExpanded = ref(false);

function readString(key: string): string | undefined {
  const value = props.arguments[key];
  return typeof value === "string" ? value : undefined;
}

function imageUrl(block: Extract<UiContentBlock, { type: "image" }>): string {
  return `data:${block.mimeType};base64,${block.data}`;
}

const pathValue = computed(() => readString("path"));
const commandValue = computed(() => readString("command"));
const contentValue = computed(() => readString("content"));
const oldTextValue = computed(() => readString("oldText"));
const newTextValue = computed(() => readString("newText"));
const timeoutValue = computed(() => {
  const value = props.arguments.timeout;
  if (typeof value === "number") {
    return `${value}s`;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value.endsWith("s") ? value : `${value}s`;
  }
  return undefined;
});
const codeLanguage = computed(() => languageFromPath(pathValue.value));
const hasResultContent = computed(() =>
  hasToolResultContent(props.resultBlocks, props.resultDetails),
);
const bashTextOutput = computed(() =>
  props.name !== "bash"
    ? ""
    : props.resultBlocks
        .filter(
          (block): block is Extract<UiContentBlock, { type: "text" }> => block.type === "text",
        )
        .map((block) => block.text)
        .join("\n"),
);
const bashTailView = computed(() => createTailView(bashTextOutput.value, OUTPUT_TAIL_LINE_COUNT));
const writeTailView = computed(() =>
  createTailView(contentValue.value ?? "", OUTPUT_TAIL_LINE_COUNT),
);
const canExpandOutput = computed(
  () =>
    (props.name === "bash" && bashTailView.value.isTrimmed) ||
    (props.name === "write" && writeTailView.value.isTrimmed),
);
const expandButtonLabel = computed(() => {
  if (!canExpandOutput.value) {
    return "";
  }
  return isExpanded.value ? "Collapse output" : "Show full output";
});
const visibleWriteContent = computed(() => {
  if (!contentValue.value) {
    return undefined;
  }
  return isExpanded.value ? contentValue.value : writeTailView.value.text;
});
const visibleBashOutput = computed(() =>
  isExpanded.value ? bashTextOutput.value : bashTailView.value.text,
);
const visibleResultBlocks = computed(() => {
  if (props.name === "read" && props.status !== "error") {
    return [];
  }

  if (props.name === "edit") {
    if (props.status === "running") {
      return props.resultBlocks;
    }

    if (props.status === "error") {
      return props.resultBlocks;
    }

    if (typeof props.resultDetails?.diff === "string") {
      return props.resultBlocks.filter((block) => block.type !== "text");
    }

    return props.resultBlocks;
  }

  if (props.name === "write") {
    if (props.status === "error") {
      return props.resultBlocks;
    }

    return props.resultBlocks.filter((block) => block.type !== "text");
  }

  if (props.name === "bash") {
    if (commandValue.value) {
      return props.resultBlocks.filter((block) => block.type !== "text");
    }

    return props.resultBlocks;
  }

  return props.resultBlocks;
});
const showEditDiff = computed(() => {
  if (props.name !== "edit") {
    return false;
  }

  if (typeof props.resultDetails?.diff === "string") {
    return true;
  }

  return typeof oldTextValue.value === "string" || typeof newTextValue.value === "string";
});
const showResultSection = computed(() => {
  if (props.name === "read") {
    return props.status === "error" && visibleResultBlocks.value.length > 0;
  }

  if (props.name === "edit") {
    return props.status === "error" || visibleResultBlocks.value.length > 0 || showEditDiff.value;
  }

  if (props.name === "write") {
    return props.status === "error" ? visibleResultBlocks.value.length > 0 : false;
  }

  if (props.name === "bash") {
    return !commandValue.value ? hasResultContent.value : visibleResultBlocks.value.length > 0;
  }

  return props.status === "error" || hasResultContent.value;
});

const readEntries = computed(() => {
  if (props.name !== "read") {
    return [];
  }

  return ["offset", "limit"]
    .map((key) => {
      const value = props.arguments[key];
      const formatted = formatValue(value);
      return formatted.trim().length > 0 ? { key, value: formatted } : undefined;
    })
    .filter((entry): entry is { key: string; value: string } => Boolean(entry));
});

const genericEntries = computed(() => {
  if (props.name === "edit") {
    return [];
  }

  const hiddenKeys = new Set([
    "path",
    "command",
    "content",
    "oldText",
    "newText",
    "timeout",
    ...(props.name === "read" ? ["offset", "limit"] : []),
  ]);
  return Object.entries(props.arguments)
    .filter(([key]) => !hiddenKeys.has(key))
    .map(([key, value]) => ({ key, value: formatValue(value) }))
    .filter((entry) => entry.value.trim().length > 0);
});
</script>

<template>
  <section :class="['tool-call', props.compact ? 'tool-call--compact' : '']">
    <header class="tool-call__header">
      <strong class="tool-call__name">{{ props.name }}</strong>
      <span v-if="props.name === 'bash' && timeoutValue" class="tool-call__timeout">
        {{ timeoutValue }}
      </span>
      <code v-if="pathValue" class="tool-call__path">{{ pathValue }}</code>
      <span
        v-if="props.status"
        :class="['tool-call__status', `tool-call__status--${props.status}`]"
      >
        <LoaderCircle
          v-if="props.status === 'running'"
          :size="14"
          class="tool-call__status-icon tool-call__status-icon--spin"
        />
        <Check v-else-if="props.status === 'success'" :size="14" class="tool-call__status-icon" />
        <CircleAlert v-else :size="14" class="tool-call__status-icon" />
      </span>
    </header>

    <div v-if="readEntries.length > 0" class="tool-call__meta tool-call__meta--read">
      <div v-for="entry in readEntries" :key="entry.key" class="tool-call__meta-chip">
        <span class="tool-call__meta-key">{{ entry.key }}</span>
        <code class="tool-call__meta-value">{{ entry.value }}</code>
      </div>
    </div>

    <div v-if="props.name === 'bash' && commandValue" class="tool-call__bash">
      <CodeBlock :code="`$ ${commandValue}`" language="bash" :compact="props.compact" />
      <div v-if="canExpandOutput" class="tool-call__expand-row">
        <button type="button" class="tool-call__expand-btn" @click="isExpanded = !isExpanded">
          {{ expandButtonLabel }}
        </button>
      </div>
      <CodeBlock
        v-if="visibleBashOutput.trim().length > 0"
        :code="visibleBashOutput"
        language="bash"
        :compact="props.compact"
      />
    </div>

    <template v-else-if="props.name === 'write' && visibleWriteContent">
      <div class="tool-call__overlay-output">
        <div v-if="canExpandOutput" class="tool-call__overlay-control">
          <button type="button" class="tool-call__expand-btn" @click="isExpanded = !isExpanded">
            {{ expandButtonLabel }}
          </button>
        </div>
        <CodeBlock :code="visibleWriteContent" :language="codeLanguage" :compact="props.compact" />
      </div>
    </template>

    <div v-if="genericEntries.length > 0" class="tool-call__meta">
      <div v-for="entry in genericEntries" :key="entry.key" class="tool-call__meta-row">
        <span class="tool-call__meta-key">{{ entry.key }}</span>
        <code class="tool-call__meta-value">{{ entry.value }}</code>
      </div>
    </div>

    <div v-if="showResultSection" class="tool-call__result">
      <template v-for="(block, index) in visibleResultBlocks" :key="`${props.name}-${index}`">
        <CodeBlock
          v-if="block.type === 'text' && props.name === 'bash'"
          :code="block.text"
          language="bash"
          :compact="props.compact"
        />
        <div v-else-if="block.type === 'text'" class="tool-call__text">{{ block.text }}</div>
        <img v-else-if="block.type === 'image'" :src="imageUrl(block)" alt="Tool output" />
        <MarkdownBlock
          v-else-if="block.type === 'thinking'"
          :text="block.thinking"
          variant="thinking"
        />
        <ToolCallBlock
          v-else-if="block.type === 'toolCall'"
          :name="block.name"
          :arguments="block.arguments"
          :compact="props.compact"
        />
      </template>

      <DiffBlock
        v-if="props.name === 'edit' && showEditDiff"
        :diff="props.resultDetails?.diff"
        :old-text="typeof props.resultDetails?.diff === 'string' ? undefined : oldTextValue"
        :new-text="typeof props.resultDetails?.diff === 'string' ? undefined : newTextValue"
        :compact="props.compact"
      />
    </div>
  </section>
</template>

<style scoped>
.tool-call {
  display: grid;
  gap: 0.45rem;
  padding: 0.55rem calc(var(--safe-area-right) + 0.8rem) 0.55rem
    calc(var(--safe-area-left) + 0.8rem);
  margin: 0.35rem calc(-1 * (var(--safe-area-right) + 0.8rem)) 0.35rem
    calc(-1 * (var(--safe-area-left) + 0.8rem));
  background: var(--color-bg-elevated-soft);
}

.tool-call--compact {
  padding: 0.4rem calc(var(--safe-area-right) + 0.8rem) 0.4rem calc(var(--safe-area-left) + 0.8rem);
}

.tool-call__header {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
}

.tool-call__name {
  color: var(--color-text-strong);
}

.tool-call__timeout,
.tool-call__meta-key {
  color: var(--color-text-subtle);
}

.tool-call__timeout {
  font-size: 0.78rem;
}

.tool-call__status {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.tool-call__status--success {
  color: var(--color-success-contrast);
}

.tool-call__status--error {
  color: var(--color-error);
}

.tool-call__status--running {
  color: var(--color-info);
}

.tool-call__status-icon {
  display: block;
}

.tool-call__status-icon--spin {
  animation: tool-call-spin 0.9s linear infinite;
}

.tool-call__path,
.tool-call__meta-value,
.tool-call__expand-btn {
  color: var(--color-info);
  background: var(--color-bg-inline-code);
  border-radius: 0.2rem;
}

.tool-call__path,
.tool-call__meta-value {
  padding: 0.12rem 0.35rem;
}

.tool-call__path {
  display: inline-block;
  white-space: normal;
  overflow-wrap: anywhere;
  vertical-align: baseline;
}

.tool-call__meta-value {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.tool-call__meta,
.tool-call__result,
.tool-call__bash {
  display: grid;
  gap: 0.4rem;
}

.tool-call__meta--read {
  display: flex;
  gap: 0.6rem 1rem;
  flex-wrap: wrap;
  align-items: center;
}

.tool-call__meta-row,
.tool-call__meta-chip {
  display: flex;
  align-items: baseline;
  gap: 0.45rem;
  flex-wrap: wrap;
}

.tool-call__meta-key {
  font-size: 0.78rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.tool-call__text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--color-text);
  line-height: 1.45;
}

.tool-call__overlay-output {
  position: relative;
  padding-top: 0.4rem;
}

.tool-call__overlay-control,
.tool-call__expand-row {
  display: flex;
  justify-content: center;
  z-index: 1;
}

.tool-call__overlay-control {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
}

.tool-call__expand-row {
  margin: -0.05rem 0;
}

.tool-call__expand-btn {
  border: 1px solid color-mix(in srgb, var(--color-info) 30%, transparent);
  padding: 0.22rem 0.65rem;
  font: inherit;
  font-size: 0.88rem;
  font-weight: 600;
  cursor: pointer;
}

.tool-call__expand-btn:hover {
  background: color-mix(in srgb, var(--color-bg-inline-code) 78%, var(--color-info));
}

.tool-call img {
  width: min(100%, 28rem);
  border-radius: 0.45rem;
}

@keyframes tool-call-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
