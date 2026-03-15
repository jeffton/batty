<script setup lang="ts">
import { Check, CircleAlert, LoaderCircle } from "lucide-vue-next";
import { computed } from "vue";
import CodeBlock from "@/client/components/CodeBlock.vue";
import DiffBlock from "@/client/components/DiffBlock.vue";
import MarkdownBlock from "@/client/components/MarkdownBlock.vue";
import { formatValue, languageFromPath } from "@/client/lib/code-format";
import { hasToolResultContent } from "@/client/lib/transcript";
import type { ToolExecutionDetails, UiContentBlock } from "@/shared/types";

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
const bashDisplay = computed(() => {
  if (props.name !== "bash" || !commandValue.value) {
    return undefined;
  }

  const lines = [`$ ${commandValue.value}`];
  if (bashTextOutput.value.trim().length > 0) {
    lines.push(bashTextOutput.value);
  }
  return lines.join("\n");
});
const visibleResultBlocks = computed(() => {
  if (props.name === "read" && props.status !== "error") {
    return [];
  }

  if (props.name === "bash") {
    return props.resultBlocks.filter((block) => block.type !== "text");
  }

  return props.resultBlocks;
});
const showResultSection = computed(() => {
  if (props.name === "read") {
    return props.status === "error" && visibleResultBlocks.value.length > 0;
  }

  if (props.name === "bash") {
    return visibleResultBlocks.value.length > 0;
  }

  return props.status === "error" || hasResultContent.value;
});

const genericEntries = computed(() => {
  const hiddenKeys = new Set(["path", "command", "content", "oldText", "newText", "timeout"]);
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

    <CodeBlock
      v-if="props.name === 'bash' && bashDisplay"
      :code="bashDisplay"
      language="bash"
      :compact="props.compact"
    />

    <template v-else-if="props.name === 'write' && contentValue">
      <CodeBlock :code="contentValue" :language="codeLanguage" :compact="props.compact" />
    </template>

    <template v-else-if="props.name === 'edit' && (oldTextValue || newTextValue)">
      <DiffBlock :old-text="oldTextValue" :new-text="newTextValue" :compact="props.compact" />
    </template>

    <div v-if="genericEntries.length > 0" class="tool-call__meta">
      <div v-for="entry in genericEntries" :key="entry.key" class="tool-call__meta-row">
        <span class="tool-call__meta-key">{{ entry.key }}</span>
        <code class="tool-call__meta-value">{{ entry.value }}</code>
      </div>
    </div>

    <div v-if="showResultSection" class="tool-call__result">
      <template v-for="(block, index) in visibleResultBlocks" :key="`${props.name}-${index}`">
        <div v-if="block.type === 'text'" class="tool-call__text">{{ block.text }}</div>
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
        v-if="props.name === 'edit' && typeof props.resultDetails?.diff === 'string'"
        :diff="props.resultDetails.diff"
        :compact="props.compact"
      />
    </div>
  </section>
</template>

<style scoped>
.tool-call {
  display: grid;
  gap: 0.45rem;
  padding: 0.45rem 0.55rem;
  border-radius: 0.45rem;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(36, 41, 51, 0.72);
}

.tool-call--compact {
  padding: 0.35rem 0.45rem;
}

.tool-call__header {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
}

.tool-call__name {
  color: #dbe4ee;
}

.tool-call__timeout {
  color: #93a0ad;
  font-size: 0.78rem;
}

.tool-call__status {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.tool-call__status--success {
  color: #86efac;
}

.tool-call__status--error {
  color: #fca5a5;
}

.tool-call__status--running {
  color: #93c5fd;
}

.tool-call__status-icon {
  display: block;
}

.tool-call__status-icon--spin {
  animation: tool-call-spin 0.9s linear infinite;
}

.tool-call__path,
.tool-call__meta-value {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: #9fc7ff;
  background: rgba(15, 23, 42, 0.65);
  border-radius: 0.2rem;
  padding: 0.12rem 0.35rem;
}

.tool-call__meta,
.tool-call__result {
  display: grid;
  gap: 0.4rem;
}

.tool-call__meta-row {
  display: flex;
  align-items: baseline;
  gap: 0.45rem;
  flex-wrap: wrap;
}

.tool-call__meta-key {
  font-size: 0.78rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #93a0ad;
}

.tool-call__text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: #cbd5e1;
  line-height: 1.45;
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

@media (max-width: 720px) {
  .tool-call__path {
    margin-left: 0;
    width: 100%;
  }
}
</style>
