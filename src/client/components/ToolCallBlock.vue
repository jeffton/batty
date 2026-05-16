<script setup lang="ts">
import { PanelRightOpen } from "lucide-vue-next";
import { computed, ref } from "vue";
import AttachedFilesList from "@/client/components/AttachedFilesList.vue";
import CodeBlock from "@/client/components/CodeBlock.vue";
import SubagentSessionPopover from "@/client/components/SubagentSessionPopover.vue";
import DiffBlock from "@/client/components/DiffBlock.vue";
import MarkdownBlock from "@/client/components/MarkdownBlock.vue";
import ToolCallCodeOutput from "@/client/components/ToolCallCodeOutput.vue";
import ToolCallHeader from "@/client/components/ToolCallHeader.vue";
import ToolCallMeta from "@/client/components/ToolCallMeta.vue";
import { formatValue, languageFromPath } from "@/client/lib/code-format";
import { createHeadView, createTailView } from "@/client/lib/tool-output";
import { hasToolResultContent } from "@/client/lib/transcript";
import type { SentFileDescriptor, ToolExecutionDetails, UiContentBlock } from "@/shared/types";

// Keep this in sync with .tool-call-code__output-window--collapsed in ToolCallCodeOutput.vue.
// The collapsed container reserves exactly one line box per truncated line so the
// transcript height stays stable while the visible tail slides during streaming.
const OUTPUT_TAIL_LINE_COUNT = 20;

type SubagentResultDetails = {
  respondIn?: unknown;
  workspaceId?: unknown;
  sessionId?: unknown;
  sessionPath?: unknown;
};

const props = withDefaults(
  defineProps<{
    name: string;
    arguments: Record<string, unknown>;
    toolCallId?: string;
    compact?: boolean;
    suppressSentFiles?: boolean;
    status?: "running" | "success" | "error";
    resultBlocks?: UiContentBlock[];
    resultDetails?: ToolExecutionDetails;
    allowSessionPopovers?: boolean;
  }>(),
  {
    toolCallId: undefined,
    compact: false,
    suppressSentFiles: false,
    status: undefined,
    resultBlocks: () => [],
    resultDetails: undefined,
    allowSessionPopovers: true,
  },
);

const isExpanded = ref(false);

function readString(key: string): string | undefined {
  const value = props.arguments[key];
  return typeof value === "string" ? value : undefined;
}

function imageUrl(block: Extract<UiContentBlock, { type: "image" }>): string {
  return block.url ?? `data:${block.mimeType};base64,${block.data ?? ""}`;
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
const subagentDetails = computed<SubagentResultDetails | undefined>(() => {
  const value = props.resultDetails?.subagent;
  return value && typeof value === "object" ? (value as SubagentResultDetails) : undefined;
});
const subagentRespondIn = computed(() => {
  return subagentDetails.value?.respondIn === "session"
    ? "session"
    : subagentDetails.value?.respondIn === "tool-call"
      ? "tool-call"
      : undefined;
});
const subagentWorkspaceId = computed(() =>
  typeof subagentDetails.value?.workspaceId === "string"
    ? subagentDetails.value.workspaceId
    : undefined,
);
const subagentSessionId = computed(() =>
  typeof subagentDetails.value?.sessionId === "string"
    ? subagentDetails.value.sessionId
    : undefined,
);
const subagentSessionPath = computed(() =>
  typeof subagentDetails.value?.sessionPath === "string"
    ? subagentDetails.value.sessionPath
    : undefined,
);
const subagentPopoverId = computed(() => {
  const stableId = props.toolCallId ?? subagentSessionId.value;
  if (!stableId) {
    return undefined;
  }

  return `subagent-session-popover-${stableId.replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
});
const canOpenSubagentSession = computed(
  () =>
    props.allowSessionPopovers &&
    props.name === "subagent" &&
    typeof subagentWorkspaceId.value === "string" &&
    typeof subagentSessionPath.value === "string" &&
    typeof subagentPopoverId.value === "string",
);
const subagentOpenLabel = computed(() =>
  props.status === "running" ? "Open live session" : "Open session",
);
const hasResultContent = computed(() =>
  hasToolResultContent(
    props.resultBlocks,
    props.suppressSentFiles ? { ...props.resultDetails, sentFiles: [] } : props.resultDetails,
  ),
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
const readTextOutput = computed(() =>
  props.name !== "read"
    ? ""
    : props.resultBlocks
        .filter(
          (block): block is Extract<UiContentBlock, { type: "text" }> => block.type === "text",
        )
        .map((block) => block.text)
        .join("\n"),
);
const readTailView = computed(() => createTailView(readTextOutput.value, OUTPUT_TAIL_LINE_COUNT));
const cronTextOutput = computed(() =>
  props.name !== "cron"
    ? ""
    : props.resultBlocks
        .filter(
          (block): block is Extract<UiContentBlock, { type: "text" }> => block.type === "text",
        )
        .map((block) => block.text)
        .join("\n"),
);
const cronHeadView = computed(() => createHeadView(cronTextOutput.value, OUTPUT_TAIL_LINE_COUNT));
const webSearchTextOutput = computed(() =>
  props.name !== "web-search"
    ? ""
    : props.resultBlocks
        .filter(
          (block): block is Extract<UiContentBlock, { type: "text" }> => block.type === "text",
        )
        .map((block) => block.text)
        .join("\n"),
);
const webSearchHeadView = computed(() =>
  createHeadView(webSearchTextOutput.value, OUTPUT_TAIL_LINE_COUNT),
);
const canExpandOutput = computed(
  () =>
    (props.name === "bash" && bashTailView.value.isTrimmed) ||
    (props.name === "write" && writeTailView.value.isTrimmed) ||
    (props.name === "read" && readTailView.value.isTrimmed) ||
    (props.name === "cron" && cronHeadView.value.isTrimmed) ||
    (props.name === "web-search" && webSearchHeadView.value.isTrimmed),
);
const expandButtonLabel = computed(() => {
  if (!canExpandOutput.value) {
    return "";
  }

  if (isExpanded.value) {
    return "Collapse output";
  }

  const hiddenLineCount =
    props.name === "bash"
      ? bashTailView.value.hiddenLineCount
      : props.name === "write"
        ? writeTailView.value.hiddenLineCount
        : props.name === "read"
          ? readTailView.value.hiddenLineCount
          : props.name === "cron"
            ? cronHeadView.value.hiddenLineCount
            : webSearchHeadView.value.hiddenLineCount;
  return `Show full output (+${hiddenLineCount} lines)`;
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
const visibleReadOutput = computed(() =>
  isExpanded.value ? readTextOutput.value : readTailView.value.text,
);
const visibleCronOutput = computed(() =>
  isExpanded.value ? cronTextOutput.value : cronHeadView.value.text,
);
const visibleWebSearchOutput = computed(() =>
  isExpanded.value ? webSearchTextOutput.value : webSearchHeadView.value.text,
);
const showCollapsedBashWindow = computed(
  () => props.name === "bash" && !isExpanded.value && bashTailView.value.isTrimmed,
);
const showCollapsedWriteWindow = computed(
  () => props.name === "write" && !isExpanded.value && writeTailView.value.isTrimmed,
);
const showCollapsedReadWindow = computed(
  () => props.name === "read" && !isExpanded.value && readTailView.value.isTrimmed,
);
const showCollapsedCronWindow = computed(
  () => props.name === "cron" && !isExpanded.value && cronHeadView.value.isTrimmed,
);
const showCollapsedWebSearchWindow = computed(
  () => props.name === "web-search" && !isExpanded.value && webSearchHeadView.value.isTrimmed,
);
const visibleResultBlocks = computed(() => {
  if ((props.name === "read" || props.name === "cron") && props.status !== "error") {
    return props.resultBlocks.filter((block) => block.type !== "text");
  }

  if (props.name === "subagent" && subagentRespondIn.value === "session") {
    return props.status === "error" ? props.resultBlocks : [];
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

  if (props.name === "web-search") {
    return props.resultBlocks.filter((block) => block.type !== "text");
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
const sentFiles = computed(() =>
  Array.isArray(props.resultDetails?.sentFiles)
    ? props.resultDetails.sentFiles.filter(
        (file): file is SentFileDescriptor =>
          Boolean(file) &&
          typeof file === "object" &&
          typeof file.id === "string" &&
          typeof file.name === "string" &&
          typeof file.size === "number" &&
          typeof file.mimeType === "string" &&
          typeof file.kind === "string" &&
          typeof file.downloadUrl === "string",
      )
    : [],
);
const hasVisibleSentFiles = computed(() => !props.suppressSentFiles && sentFiles.value.length > 0);

const showResultSection = computed(() => {
  if (props.name === "read") {
    return props.status === "error" && visibleResultBlocks.value.length > 0;
  }

  if (props.name === "cron") {
    return props.status === "error" || visibleResultBlocks.value.length > 0;
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

  if (props.name === "attach-files") {
    return props.status === "error" || hasVisibleSentFiles.value || hasResultContent.value;
  }

  if (props.name === "subagent" && subagentRespondIn.value === "session") {
    return props.status === "error";
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
    <ToolCallHeader
      :name="props.name"
      :path="pathValue"
      :timeout="timeoutValue"
      :status="props.status"
    />

    <ToolCallMeta :entries="readEntries" inline />

    <template
      v-if="
        props.name === 'read' && props.status !== 'error' && visibleReadOutput.trim().length > 0
      "
    >
      <ToolCallCodeOutput
        :code="visibleReadOutput"
        :language="codeLanguage"
        :compact="props.compact"
        :collapsed="showCollapsedReadWindow"
        :can-expand="canExpandOutput"
        :expand-button-label="expandButtonLabel"
        @toggle-expanded="isExpanded = !isExpanded"
      />
    </template>

    <template
      v-else-if="
        props.name === 'cron' && props.status !== 'error' && visibleCronOutput.trim().length > 0
      "
    >
      <ToolCallCodeOutput
        :code="visibleCronOutput"
        language="json"
        :compact="props.compact"
        :collapsed="showCollapsedCronWindow"
        :can-expand="canExpandOutput"
        :expand-button-label="expandButtonLabel"
        @toggle-expanded="isExpanded = !isExpanded"
      />
    </template>

    <ToolCallCodeOutput
      v-else-if="props.name === 'bash' && commandValue"
      :code="visibleBashOutput"
      language="bash"
      :compact="props.compact"
      :collapsed="showCollapsedBashWindow"
      :can-expand="canExpandOutput"
      :expand-button-label="expandButtonLabel"
      :command="commandValue"
      button-placement="before"
      @toggle-expanded="isExpanded = !isExpanded"
    />

    <template v-else-if="props.name === 'write' && visibleWriteContent">
      <ToolCallCodeOutput
        :code="visibleWriteContent"
        :language="codeLanguage"
        :compact="props.compact"
        :collapsed="showCollapsedWriteWindow"
        :can-expand="canExpandOutput"
        :expand-button-label="expandButtonLabel"
        button-placement="overlay"
        @toggle-expanded="isExpanded = !isExpanded"
      />
    </template>

    <ToolCallMeta :entries="genericEntries" />

    <div v-if="canOpenSubagentSession" class="tool-call__subagent-row">
      <button type="button" class="tool-call__subagent-btn" :popovertarget="subagentPopoverId">
        <PanelRightOpen :size="14" />
        {{ subagentOpenLabel }}
      </button>
      <SubagentSessionPopover
        :popover-id="subagentPopoverId!"
        :title="String(props.arguments.prompt ?? '')"
        :workspace-id="subagentWorkspaceId!"
        :session-path="subagentSessionPath!"
      />
    </div>

    <template v-if="props.name === 'web-search' && visibleWebSearchOutput.trim().length > 0">
      <ToolCallCodeOutput
        :code="visibleWebSearchOutput"
        language="markdown"
        :compact="props.compact"
        :collapsed="showCollapsedWebSearchWindow"
        :can-expand="canExpandOutput"
        :expand-button-label="expandButtonLabel"
        @toggle-expanded="isExpanded = !isExpanded"
      />
    </template>

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
          :tool-call-id="block.id"
          :compact="props.compact"
          :allow-session-popovers="props.allowSessionPopovers"
        />
      </template>

      <AttachedFilesList
        v-if="
          hasVisibleSentFiles && !(props.name === 'subagent' && subagentRespondIn === 'session')
        "
        :files="sentFiles"
        :preview="props.name !== 'attach-files'"
        :compact="props.compact"
      />

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
  margin: 0 calc(-1 * (var(--safe-area-right) + 0.8rem)) 0
    calc(-1 * (var(--safe-area-left) + 0.8rem));
  background: var(--color-bg-elevated-soft);
}

.tool-call--compact {
  padding: 0.4rem calc(var(--safe-area-right) + 0.8rem) 0.4rem calc(var(--safe-area-left) + 0.8rem);
}

.tool-call__result,
.tool-call__subagent-row {
  display: grid;
  gap: 0.4rem;
}

.tool-call__text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--color-text);
  line-height: 1.45;
}

.tool-call__subagent-row {
  justify-items: start;
}

.tool-call__subagent-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  border: 1px solid color-mix(in srgb, var(--color-info) 30%, transparent);
  border-radius: 0.5rem;
  padding: 0.35rem 0.7rem;
  font: inherit;
  font-size: 0.88rem;
  font-weight: 600;
  color: var(--color-info);
  background: var(--color-bg-inline-code);
  cursor: pointer;
}

@media (hover: hover) {
  .tool-call__subagent-btn:hover {
    background: color-mix(in srgb, var(--color-bg-inline-code) 78%, var(--color-info));
  }
}

.tool-call img {
  width: min(100%, 28rem);
  border-radius: 0.45rem;
}
</style>
