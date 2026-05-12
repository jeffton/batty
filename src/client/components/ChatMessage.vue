<script setup lang="ts">
import { Cog, PanelRightOpen } from "lucide-vue-next";
import { computed } from "vue";
import { BATTY_RUNTIME_NOTICE_CUSTOM_TYPE } from "@/server/runtime-notices";
import AttachedFilesList from "@/client/components/AttachedFilesList.vue";
import CodeBlock from "@/client/components/CodeBlock.vue";
import MarkdownBlock from "@/client/components/MarkdownBlock.vue";
import SubagentSessionPopover from "@/client/components/SubagentSessionPopover.vue";
import ToolCallBlock from "@/client/components/ToolCallBlock.vue";
import { isAttachmentOutputToolCall } from "@/client/lib/transcript";
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
  return block.url ?? `data:${block.mimeType};base64,${block.data ?? ""}`;
}

function toolStateFor(toolCallId: string): ToolDisplayState | undefined {
  return props.toolStatesByCallId.get(toolCallId);
}

function isBubbleBlock(block: UiContentBlock): boolean {
  return block.type === "text" || block.type === "image";
}

function showAssistantBlock(block: UiContentBlock): boolean {
  return block.type !== "thinking" && !isAttachmentOutputToolCall(block, props.toolStatesByCallId);
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

const assistantSegments = computed<AssistantSegment[]>(() => {
  if (props.message.role !== "assistant") {
    return [];
  }

  const blocks = props.message.blocks.filter(showAssistantBlock);
  if (blocks.length === 0) {
    return [];
  }

  let trailingBubbleStart = blocks.length;

  while (
    trailingBubbleStart > 0 &&
    isBubbleBlock(blocks[trailingBubbleStart - 1] as UiContentBlock)
  ) {
    trailingBubbleStart -= 1;
  }

  if (trailingBubbleStart === 0) {
    return [{ kind: "bubble", blocks }];
  }

  if (trailingBubbleStart === blocks.length) {
    return [{ kind: "plain", blocks }];
  }

  return [
    { kind: "plain", blocks: blocks.slice(0, trailingBubbleStart) },
    { kind: "bubble", blocks: blocks.slice(trailingBubbleStart) },
  ];
});

const isRuntimeNotice = computed(
  () =>
    props.message.role === "custom" &&
    props.message.customType.startsWith(BATTY_RUNTIME_NOTICE_CUSTOM_TYPE),
);

const cronNoticeDetails = computed(() => {
  if (props.message.role !== "custom") {
    return undefined;
  }
  const cron = props.message.data?.cron;
  if (!cron || typeof cron !== "object") {
    return undefined;
  }
  const details = cron as Record<string, unknown>;
  return typeof details.workspaceId === "string" && typeof details.sessionPath === "string"
    ? {
        workspaceId: details.workspaceId,
        sessionPath: details.sessionPath,
        prompt: typeof details.prompt === "string" ? details.prompt : "Cron run",
        runId: typeof details.runId === "string" ? details.runId : props.message.id,
      }
    : undefined;
});

const cronNoticePopoverId = computed(() => {
  if (!cronNoticeDetails.value) {
    return undefined;
  }
  return `cron-notice-popover-${cronNoticeDetails.value.runId.replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
});

const assistantErrorText = computed(() => {
  if (props.message.role !== "assistant") {
    return undefined;
  }

  const errorMessage = props.message.errorMessage?.trim();
  if (errorMessage) {
    return errorMessage;
  }

  return props.message.stopReason === "error" ? "Request failed." : undefined;
});

const assistantHasError = computed(
  () => props.message.role === "assistant" && typeof assistantErrorText.value === "string",
);

const showAssistantErrorBubble = computed(
  () => props.message.role === "assistant" && assistantSegments.value.length === 0,
);

const hasTrailingAssistantBubble = computed(() => {
  const lastSegment = assistantSegments.value.at(-1);
  return lastSegment?.kind === "bubble";
});

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

    if (block.name !== "attach-files" && block.name !== "subagent") {
      continue;
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
      <div
        :class="['message__system-bubble', { 'message__system-bubble--runtime': isRuntimeNotice }]"
      >
        <span class="message__system-icon" aria-hidden="true">
          <Cog :size="16" />
        </span>
        <div class="message__text">
          {{ props.message.text }}
          <div v-if="cronNoticeDetails && cronNoticePopoverId" class="message__notice-actions">
            <button type="button" class="message__notice-btn" :popovertarget="cronNoticePopoverId">
              <PanelRightOpen :size="14" />
              Open cron session
            </button>
            <SubagentSessionPopover
              :popover-id="cronNoticePopoverId"
              header-title="Cron run"
              :title="cronNoticeDetails.prompt"
              :workspace-id="cronNoticeDetails.workspaceId"
              :session-path="cronNoticeDetails.sessionPath"
            />
          </div>
        </div>
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
        :class="[
          'message__segment',
          {
            'message__segment--bubble': segment.kind === 'bubble',
            'message__segment--error': segment.kind === 'bubble' && assistantHasError,
          },
        ]"
      >
        <template
          v-for="(block, blockIndex) in segment.blocks"
          :key="`${segmentIndex}-${blockIndex}`"
        >
          <MarkdownBlock v-if="block.type === 'text'" :text="block.text" />
          <img
            v-else-if="block.type === 'image'"
            :src="imageUrl(block)"
            :alt="block.name ?? 'Message attachment'"
          />
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
            :suppress-sent-files="block.name === 'attach-files' || block.name === 'subagent'"
          />
        </template>

        <AttachedFilesList
          v-if="
            attachedFiles.length > 0 &&
            segmentIndex === assistantSegments.length - 1 &&
            segment.kind === 'bubble'
          "
          :files="attachedFiles"
        />
      </div>

      <div
        v-if="attachedFiles.length > 0 && !hasTrailingAssistantBubble"
        class="message__segment message__segment--bubble"
      >
        <AttachedFilesList :files="attachedFiles" />
      </div>

      <div
        v-if="showAssistantErrorBubble && assistantErrorText"
        class="message__segment message__segment--bubble message__segment--error"
      >
        <div class="message__text">{{ assistantErrorText }}</div>
      </div>
    </div>

    <div v-else class="message__body">
      <template
        v-for="(block, index) in props.message.blocks"
        :key="`${props.message.id}-${index}`"
      >
        <div v-if="block.type === 'text'" class="message__text">{{ block.text }}</div>
        <img
          v-else-if="block.type === 'image'"
          :src="imageUrl(block)"
          :alt="block.name ?? 'Message attachment'"
        />
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
  position: relative;
  display: grid;
  min-width: 0;
}

.message::before,
.message__segment--bubble::before {
  content: "";
  position: absolute;
  inset: 0;
  background: var(--message-bg, transparent);
  border-radius: inherit;
  z-index: 0;
  pointer-events: none;
}

.message > *,
.message__segment--bubble > * {
  position: relative;
  z-index: 1;
}

.message--toolResult,
.message--bashExecution,
.message--custom {
  padding: 0;
  background: transparent;
}

.message--user {
  --message-bg: var(--color-user-bg);
  padding: 0.5rem 0 0.5rem 0.65rem;
  border-radius: 0.5rem 0 0 0.5rem;
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

.message--user::before {
  right: calc(-1 * (var(--safe-area-right) + 0.8rem));
}

.message__segment--bubble {
  --message-bg: var(--color-bg-panel);
  position: relative;
  padding: 0.5rem 0.65rem 0.5rem 0;
  border-radius: 0 0.5rem 0.5rem 0;
  color: var(--color-text);
}

.message__segment--bubble::before {
  left: calc(-1 * (var(--safe-area-left) + 0.8rem));
}

.message__segment--error {
  --message-bg: var(--color-error-soft);
  color: var(--color-error);
}

.message__text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.5;
}

.message__system-bubble {
  display: inline-flex;
  align-items: flex-start;
  gap: 0.55rem;
  max-width: 100%;
  padding: 0.5rem 0.65rem;
  border-radius: 0.5rem;
  background: var(--color-info-soft);
  color: var(--color-info);
}

.message__system-bubble--runtime {
  background: var(--color-info-soft);
  color: var(--color-info);
}

.message__system-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  margin-top: 0.12rem;
}

.message__system-icon :deep(svg) {
  display: block;
}

.message__notice-actions {
  margin-top: 0.45rem;
}

.message__notice-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.3rem 0.5rem;
  border: 1px solid color-mix(in srgb, var(--color-info) 30%, transparent);
  border-radius: 0.45rem;
  background: color-mix(in srgb, var(--color-info-soft) 75%, var(--color-bg-panel));
  color: var(--color-info);
  font: inherit;
  font-size: 0.82rem;
  cursor: pointer;
}

img {
  max-width: min(100%, 32rem);
  border-radius: 0.45rem;
}
</style>
