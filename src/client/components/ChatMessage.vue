<script setup lang="ts">
import { computed } from "vue";
import { BATTY_RUNTIME_NOTICE_CUSTOM_TYPE } from "@/server/runtime-notices";
import AttachedFilesList from "@/client/components/AttachedFilesList.vue";
import CodeBlock from "@/client/components/CodeBlock.vue";
import MarkdownBlock from "@/client/components/MarkdownBlock.vue";
import ToolCallBlock from "@/client/components/ToolCallBlock.vue";
import type { ToolDisplayState } from "@/client/lib/transcript";
import type { SentFileDescriptor, UiContentBlock, UiMessage } from "@/shared/types";

type AssistantSegment = {
  kind: "bubble" | "plain";
  blocks: UiContentBlock[];
};

const props = withDefaults(
  defineProps<{
    message: UiMessage;
    toolStatesByCallId?: Map<string, ToolDisplayState>;
  }>(),
  {
    toolStatesByCallId: () => new Map(),
  },
);

function imageUrl(block: Extract<UiContentBlock, { type: "image" }>): string {
  return `data:${block.mimeType};base64,${block.data}`;
}

function toolStateFor(toolCallId: string): ToolDisplayState | undefined {
  return props.toolStatesByCallId.get(toolCallId);
}

function isBubbleBlock(block: UiContentBlock): boolean {
  return block.type === "text" || block.type === "image";
}

function isSentFileDescriptor(candidate: unknown): candidate is SentFileDescriptor {
  return (
    !!candidate &&
    typeof candidate === "object" &&
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.size === "number" &&
    typeof candidate.mimeType === "string" &&
    typeof candidate.kind === "string" &&
    typeof candidate.downloadUrl === "string"
  );
}

function subagentRespondIn(toolCallId: string): string | undefined {
  const subagent = toolStateFor(toolCallId)?.resultDetails?.subagent;
  return subagent && typeof subagent === "object" && typeof subagent.respondIn === "string"
    ? subagent.respondIn
    : undefined;
}

const assistantSegments = computed<AssistantSegment[]>(() => {
  if (props.message.role !== "assistant" || props.message.blocks.length === 0) {
    return [];
  }

  let trailingBubbleStart = props.message.blocks.length;

  while (
    trailingBubbleStart > 0 &&
    isBubbleBlock(props.message.blocks[trailingBubbleStart - 1] as UiContentBlock)
  ) {
    trailingBubbleStart -= 1;
  }

  if (trailingBubbleStart === 0) {
    return [{ kind: "bubble", blocks: [...props.message.blocks] }];
  }

  if (trailingBubbleStart === props.message.blocks.length) {
    return [{ kind: "plain", blocks: [...props.message.blocks] }];
  }

  return [
    { kind: "plain", blocks: props.message.blocks.slice(0, trailingBubbleStart) },
    { kind: "bubble", blocks: props.message.blocks.slice(trailingBubbleStart) },
  ];
});

const isRuntimeNotice = computed(
  () =>
    props.message.role === "custom" &&
    props.message.customType.startsWith(BATTY_RUNTIME_NOTICE_CUSTOM_TYPE),
);

const attachedFiles = computed<SentFileDescriptor[]>(() => {
  if (props.message.role !== "assistant") {
    return [];
  }

  const files: SentFileDescriptor[] = [];
  const seen = new Set<string>();

  for (const block of props.message.blocks) {
    if (block.type !== "toolCall") {
      continue;
    }

    if (block.name !== "attach-files") {
      if (!(block.name === "subagent" && subagentRespondIn(block.id) === "session")) {
        continue;
      }
    }

    const candidates = toolStateFor(block.id)?.resultDetails?.sentFiles;
    if (!Array.isArray(candidates)) {
      continue;
    }

    for (const candidate of candidates) {
      if (!isSentFileDescriptor(candidate) || seen.has(candidate.id)) {
        continue;
      }

      seen.add(candidate.id);
      files.push(candidate);
    }
  }

  return files;
});
</script>

<template>
  <article :class="['message', `message--${props.message.role}`]">
    <div v-if="props.message.role === 'bashExecution'" class="message__body">
      <CodeBlock :code="`$ ${props.message.command}\n${props.message.output}`" language="bash" />
    </div>

    <div v-else-if="props.message.role === 'custom'" class="message__body">
      <div :class="['message__text', { 'message__runtime-notice': isRuntimeNotice }]">
        {{ props.message.text }}
      </div>
    </div>

    <div v-else-if="props.message.role === 'toolResult'" class="message__body">
      <ToolCallBlock
        :name="props.message.toolName"
        :arguments="{}"
        :tool-call-id="props.message.toolCallId"
        :result-blocks="props.message.blocks"
        :result-details="props.message.details"
        :status="props.message.isError ? 'error' : 'success'"
      />
    </div>

    <div v-else-if="props.message.role === 'assistant'" class="message__body">
      <div
        v-for="(segment, segmentIndex) in assistantSegments"
        :key="`${props.message.id}-segment-${segmentIndex}`"
        :class="['message__segment', { 'message__segment--bubble': segment.kind === 'bubble' }]"
      >
        <template
          v-for="(block, blockIndex) in segment.blocks"
          :key="`${segmentIndex}-${blockIndex}`"
        >
          <MarkdownBlock v-if="block.type === 'text'" :text="block.text" />
          <img v-else-if="block.type === 'image'" :src="imageUrl(block)" alt="Message attachment" />
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
            :result-blocks="toolStateFor(block.id)?.resultBlocks ?? []"
            :result-details="toolStateFor(block.id)?.resultDetails"
            :status="toolStateFor(block.id)?.status"
          />
        </template>
      </div>

      <AttachedFilesList v-if="attachedFiles.length > 0" :files="attachedFiles" />
    </div>

    <div v-else class="message__body">
      <template
        v-for="(block, index) in props.message.blocks"
        :key="`${props.message.id}-${index}`"
      >
        <div v-if="block.type === 'text'" class="message__text">{{ block.text }}</div>
        <img v-else-if="block.type === 'image'" :src="imageUrl(block)" alt="Message attachment" />
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
          :result-blocks="toolStateFor(block.id)?.resultBlocks ?? []"
          :result-details="toolStateFor(block.id)?.resultDetails"
          :status="toolStateFor(block.id)?.status"
        />
      </template>
    </div>
  </article>
</template>

<style scoped>
.message {
  display: grid;
  min-width: 0;
}

.message--toolResult,
.message--bashExecution,
.message--custom {
  padding: 0;
  background: transparent;
}

.message--user {
  padding: 0.5rem 0.65rem;
  border-radius: 0.5rem;
  background: var(--color-user-bg);
  color: var(--color-user-text);
  margin-left: auto;
  font-family:
    "JetBrains Mono", "SFMono-Regular", ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 0.92em;
}

.message__body {
  display: grid;
  gap: 0.45rem;
  min-width: 0;
}

.message__segment {
  display: grid;
  gap: 0.45rem;
  min-width: 0;
}

.message__segment--bubble {
  padding: 0.5rem 0.65rem;
  border-radius: 0.5rem;
  background: var(--color-bg-panel);
  color: var(--color-text);
}

.message__text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.5;
}

.message__runtime-notice {
  padding: 0.45rem 0.65rem;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-bg-panel) 75%, transparent);
  border: 1px solid var(--color-border);
  color: var(--color-text-muted);
  font-size: 0.92rem;
}

img {
  max-width: min(100%, 32rem);
  border-radius: 0.45rem;
}
</style>
