<script setup lang="ts">
import { computed } from "vue";
import CodeBlock from "@/client/components/CodeBlock.vue";
import MarkdownBlock from "@/client/components/MarkdownBlock.vue";
import ToolCallBlock from "@/client/components/ToolCallBlock.vue";
import type { ToolDisplayState } from "@/client/lib/transcript";
import type { UiContentBlock, UiMessage } from "@/shared/types";

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
</script>

<template>
  <article :class="['message', `message--${props.message.role}`]">
    <div v-if="props.message.role === 'bashExecution'" class="message__body">
      <CodeBlock :code="`$ ${props.message.command}\n${props.message.output}`" language="bash" />
    </div>

    <div v-else-if="props.message.role === 'custom'" class="message__body">
      <div class="message__text">{{ props.message.text }}</div>
    </div>

    <div v-else-if="props.message.role === 'toolResult'" class="message__body">
      <ToolCallBlock
        :name="props.message.toolName"
        :arguments="{}"
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
            :result-blocks="toolStateFor(block.id)?.resultBlocks ?? []"
            :result-details="toolStateFor(block.id)?.resultDetails"
            :status="toolStateFor(block.id)?.status"
          />
        </template>
      </div>
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

img {
  max-width: min(100%, 32rem);
  border-radius: 0.45rem;
}
</style>
