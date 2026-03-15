<script setup lang="ts">
import { computed } from "vue";
import CodeBlock from "@/client/components/CodeBlock.vue";
import DiffBlock from "@/client/components/DiffBlock.vue";
import { formatValue, languageFromPath } from "@/client/lib/code-format";

const props = withDefaults(
  defineProps<{
    name: string;
    arguments: Record<string, unknown>;
    compact?: boolean;
  }>(),
  {
    compact: false,
  },
);

function readString(key: string): string | undefined {
  const value = props.arguments[key];
  return typeof value === "string" ? value : undefined;
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
    </header>

    <CodeBlock
      v-if="props.name === 'bash' && commandValue"
      :code="commandValue"
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

.tool-call__path,
.tool-call__meta-value {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: #9fc7ff;
  background: rgba(15, 23, 42, 0.65);
  border-radius: 0.2rem;
  padding: 0.12rem 0.35rem;
}

.tool-call__diff,
.tool-call__meta {
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

@media (max-width: 720px) {
  .tool-call__path {
    margin-left: 0;
    width: 100%;
  }
}
</style>
