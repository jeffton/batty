<script setup lang="ts">
import { Cog, FileDiff, PanelRightOpen } from "@lucide/vue";
import { computed, onBeforeUnmount, ref } from "vue";
import { BATTY_RUNTIME_NOTICE_CUSTOM_TYPE } from "@/server/runtime-notices";
import AgentTurnDiffPopover from "@/client/components/AgentTurnDiffPopover.vue";
import AttachedFilesList from "@/client/components/AttachedFilesList.vue";
import CodeBlock from "@/client/components/CodeBlock.vue";
import MarkdownBlock from "@/client/components/MarkdownBlock.vue";
import ReplyActions from "@/client/components/ReplyActions.vue";
import SharedSitesList from "@/client/components/SharedSitesList.vue";
import SubagentSessionPopover from "@/client/components/SubagentSessionPopover.vue";
import ToolCallBlock from "@/client/components/ToolCallBlock.vue";
import TranscriptImage from "@/client/components/TranscriptImage.vue";
import { isAttachmentOutputToolCall } from "@/client/lib/transcript";
import { hasNoReplyText } from "@/shared/chat-only-context";
import type { ToolDisplayState } from "@/client/lib/transcript";
import type {
  SentFileDescriptor,
  SiteAttachmentDescriptor,
  UiContentBlock,
  UiMessage,
} from "@/shared/types";

type AssistantSegment = {
  kind: "reply" | "interim" | "plain";
  blocks: UiContentBlock[];
};

const copied = ref(false);
let copiedTimeout: number | undefined;

const props = withDefaults(
  defineProps<{
    message: UiMessage;
    toolStatesByCallId?: Map<string, ToolDisplayState>;
    showTimestamp?: boolean;
    allowSessionPopovers?: boolean;
  }>(),
  {
    toolStatesByCallId: () => new Map(),
    showTimestamp: false,
    allowSessionPopovers: true,
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

function markdownForBlock(block: UiContentBlock): string | undefined {
  if (block.type === "text") {
    return block.text;
  }

  if (block.type === "image") {
    return `![${block.name ?? "Message attachment"}](${imageUrl(block)})`;
  }

  return undefined;
}

function showAssistantBlock(block: UiContentBlock): boolean {
  return (
    (block.type !== "text" || block.text.trim().length > 0) &&
    !isAttachmentOutputToolCall(block, props.toolStatesByCallId)
  );
}

function isSentFileDescriptor(candidate: unknown): candidate is SentFileDescriptor {
  return (
    !!candidate &&
    typeof candidate === "object" &&
    typeof (candidate as SentFileDescriptor).id === "string" &&
    typeof (candidate as SentFileDescriptor).name === "string" &&
    typeof (candidate as SentFileDescriptor).size === "number" &&
    typeof (candidate as SentFileDescriptor).mimeType === "string" &&
    typeof (candidate as SentFileDescriptor).kind === "string" &&
    typeof (candidate as SentFileDescriptor).downloadUrl === "string"
  );
}

const assistantSegments = computed<AssistantSegment[]>(() => {
  if (props.message.role !== "assistant") {
    return [];
  }

  const segments: AssistantSegment[] = [];
  const bubbleKind = props.message.turnPhase === "final" ? "reply" : "interim";
  const silent = hasNoReplyText(props.message.blocks);

  for (const block of props.message.blocks.filter(showAssistantBlock)) {
    // Sentinel text is diagnostic; image replies retain their actions and details control.
    const kind = isBubbleBlock(block) && !(silent && block.type === "text") ? bubbleKind : "plain";
    const previousSegment = segments.at(-1);

    if (previousSegment?.kind === kind) {
      previousSegment.blocks.push(block);
    } else {
      segments.push({ kind, blocks: [block] });
    }
  }

  return segments;
});

function segmentKey(index: number): string {
  const kind = assistantSegments.value[index]!.kind;
  const ordinal = assistantSegments.value
    .slice(0, index)
    .filter((segment) => segment.kind === kind).length;
  return `${props.message.id}-${kind}-${ordinal}`;
}

const isRuntimeNotice = computed(
  () =>
    props.message.role === "custom" &&
    props.message.customType.startsWith(BATTY_RUNTIME_NOTICE_CUSTOM_TYPE),
);

const runtimeNoticeContent = computed(() => {
  if (!isRuntimeNotice.value || props.message.role !== "custom") {
    return undefined;
  }
  return props.message.data?.runtimeNotice as { text: string; markdown: string } | undefined;
});

const cronNoticeDetails = computed(() => {
  if (props.message.role !== "custom") {
    return undefined;
  }
  const cron = props.message.data?.cron;
  if (!cron || typeof cron !== "object") {
    return undefined;
  }
  const details = cron as Record<string, unknown>;
  return typeof details.sessionId === "string"
    ? {
        sessionId: details.sessionId,
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

const subagentNoticeDetails = computed(() => {
  if (props.message.role !== "custom") {
    return undefined;
  }
  const subagent = props.message.data?.subagent;
  if (!subagent || typeof subagent !== "object") {
    return undefined;
  }
  const details = subagent as Record<string, unknown>;
  return typeof details.sessionId === "string" ? { sessionId: details.sessionId } : undefined;
});

const subagentNoticePopoverId = computed(() => {
  if (!subagentNoticeDetails.value) {
    return undefined;
  }
  return `subagent-notice-popover-${subagentNoticeDetails.value.sessionId.replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
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

const replySegmentIndex = computed(() =>
  assistantSegments.value.findIndex((segment) => segment.kind === "reply"),
);

const lastReplySegmentIndex = computed(() =>
  assistantSegments.value.findLastIndex((segment) => segment.kind === "reply"),
);

const hasAssistantReplySegment = computed(() => replySegmentIndex.value >= 0);

const showAssistantErrorBubble = computed(
  () => props.message.role === "assistant" && !!assistantErrorText.value,
);

const messageTimestampLabel = computed(() => {
  const timestamp = props.message.timestamp;
  const date = new Date(timestamp);
  const now = new Date();
  const locales = navigator.languages.length > 0 ? navigator.languages : navigator.language;
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  if (isToday) {
    return date.toLocaleTimeString(locales, { hour: "2-digit", minute: "2-digit" });
  }

  return date.toLocaleString(locales, { dateStyle: "medium", timeStyle: "short" });
});

const noticeArtifacts = computed(() =>
  isRuntimeNotice.value && props.message.role === "custom"
    ? (props.message.data?.runtimeResultArtifacts as
        | {
            sentFiles?: SentFileDescriptor[];
            sites?: SiteAttachmentDescriptor[];
            fileChanges?: import("@/shared/types").AgentTurnFileChange[];
          }
        | undefined)
    : undefined,
);

const attachedFiles = computed<SentFileDescriptor[]>(() => {
  if (noticeArtifacts.value) return noticeArtifacts.value.sentFiles ?? [];
  if (props.message.role !== "assistant") {
    return [];
  }

  const files: SentFileDescriptor[] = [...(props.message.sentFiles ?? [])];
  const seen = new Set(files.map((file) => file.id));

  for (const block of props.message.blocks) {
    if (block.type !== "toolCall") {
      continue;
    }

    if (block.name !== "attach_files") {
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

function isSiteAttachmentDescriptor(candidate: unknown): candidate is SiteAttachmentDescriptor {
  return (
    !!candidate &&
    typeof candidate === "object" &&
    typeof (candidate as SiteAttachmentDescriptor).id === "string" &&
    typeof (candidate as SiteAttachmentDescriptor).name === "string" &&
    typeof (candidate as SiteAttachmentDescriptor).url === "string" &&
    (((candidate as SiteAttachmentDescriptor).kind === "site" &&
      typeof (candidate as SiteAttachmentDescriptor).public === "boolean") ||
      ((candidate as SiteAttachmentDescriptor).kind === "browser" &&
        (candidate as { public?: unknown }).public === false &&
        typeof (candidate as { browserId?: unknown }).browserId === "string"))
  );
}

const sharedSites = computed<SiteAttachmentDescriptor[]>(() => {
  if (noticeArtifacts.value) return noticeArtifacts.value.sites ?? [];
  if (props.message.role !== "assistant") return [];
  const sites: SiteAttachmentDescriptor[] = [...(props.message.sites ?? [])];
  const seen = new Set(sites.map((site) => site.id));
  for (const block of props.message.blocks) {
    if (block.type !== "toolCall" || (block.name !== "sites" && block.name !== "attach_files")) {
      continue;
    }
    const candidates = toolStateFor(block.id)?.resultDetails?.sites;
    if (!Array.isArray(candidates)) continue;
    for (const candidate of candidates) {
      if (!isSiteAttachmentDescriptor(candidate) || seen.has(candidate.id)) continue;
      seen.add(candidate.id);
      sites.push(candidate);
    }
  }
  return sites;
});

const fileChanges = computed(() =>
  props.message.role === "assistant"
    ? (props.message.fileChanges ?? [])
    : (noticeArtifacts.value?.fileChanges ?? []),
);
const hasReplyArtifacts = computed(
  () =>
    attachedFiles.value.length > 0 || sharedSites.value.length > 0 || fileChanges.value.length > 0,
);
const diffPopoverId = computed(
  () => `agent-turn-diff-${props.message.id.replace(/[^a-zA-Z0-9_-]+/g, "-")}`,
);

const assistantMarkdown = computed(() => {
  if (props.message.role !== "assistant") {
    return "";
  }

  const markdown = props.message.blocks
    .filter(showAssistantBlock)
    .map(markdownForBlock)
    .filter((block): block is string => typeof block === "string" && block.length > 0)
    .join("\n\n");

  const attachmentMarkdown = attachedFiles.value
    .map((file) => `[${file.name}](${file.downloadUrl})`)
    .join("\n");

  const siteMarkdown = sharedSites.value.map((site) => `[${site.name}](${site.url})`).join("\n");
  const errorMarkdown = assistantErrorText.value;

  return [markdown, attachmentMarkdown, siteMarkdown, errorMarkdown]
    .filter((section): section is string => typeof section === "string" && section.length > 0)
    .join("\n\n");
});

async function copyAssistantMarkdown(): Promise<void> {
  await navigator.clipboard.writeText(assistantMarkdown.value);
  copied.value = true;

  if (copiedTimeout !== undefined) {
    window.clearTimeout(copiedTimeout);
  }

  copiedTimeout = window.setTimeout(() => {
    copied.value = false;
    copiedTimeout = undefined;
  }, 1400);
}

onBeforeUnmount(() => {
  if (copiedTimeout !== undefined) {
    window.clearTimeout(copiedTimeout);
  }
});
</script>

<template>
  <div v-if="props.message.role === 'user' && props.showTimestamp" class="message__timestamp">
    {{ messageTimestampLabel }}
  </div>

  <article :class="['message', `message--${props.message.role}`]">
    <div v-if="props.message.role === 'bashExecution'" class="message__body">
      <CodeBlock :code="`$ ${props.message.command}\n${props.message.output}`" language="bash" />
    </div>

    <div v-else-if="props.message.role === 'custom'" class="message__body">
      <div class="message__system-bubble">
        <span class="message__system-icon" aria-hidden="true">
          <Cog :size="16" />
        </span>
        <div class="message__text">
          <template v-if="isRuntimeNotice">
            <div class="message__notice-text">
              {{ runtimeNoticeContent?.text ?? props.message.text }}
            </div>
            <MarkdownBlock
              v-if="runtimeNoticeContent"
              class="message__runtime-markdown"
              :text="runtimeNoticeContent.markdown"
            />
          </template>
          <template v-else>{{ props.message.text }}</template>
          <div v-if="hasReplyArtifacts" class="message__artifacts">
            <AttachedFilesList
              v-if="attachedFiles.length"
              class="message__notice-files"
              :files="attachedFiles"
            />
            <SharedSitesList
              v-if="sharedSites.length"
              class="message__notice-sites"
              :sites="sharedSites"
              :id-prefix="props.message.id"
            />
            <button
              v-if="fileChanges.length"
              type="button"
              class="message__diff-button"
              :popovertarget="diffPopoverId"
            >
              <FileDiff :size="16" />
              View changes
              <span class="message__diff-count">{{ fileChanges.length }}</span>
            </button>
            <AgentTurnDiffPopover
              v-if="fileChanges.length"
              :popover-id="diffPopoverId"
              :files="fileChanges"
            />
          </div>
          <div
            v-if="props.allowSessionPopovers && cronNoticeDetails && cronNoticePopoverId"
            class="message__notice-actions"
          >
            <button type="button" class="message__notice-btn" :popovertarget="cronNoticePopoverId">
              <PanelRightOpen :size="14" />
              Open cron session
            </button>
            <SubagentSessionPopover
              :popover-id="cronNoticePopoverId"
              header-title="Cron run"
              :session-id="cronNoticeDetails.sessionId"
            />
          </div>
          <div
            v-if="props.allowSessionPopovers && subagentNoticeDetails && subagentNoticePopoverId"
            class="message__notice-actions"
          >
            <button
              type="button"
              class="message__notice-btn"
              :popovertarget="subagentNoticePopoverId"
            >
              <PanelRightOpen :size="14" />
              Open subagent session
            </button>
            <SubagentSessionPopover
              :popover-id="subagentNoticePopoverId"
              header-title="Subagent"
              :session-id="subagentNoticeDetails.sessionId"
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
        :allow-session-popovers="props.allowSessionPopovers"
      />
    </div>

    <div v-else-if="props.message.role === 'assistant'" class="message__body">
      <div v-if="props.message.stopReason === 'aborted'" class="message__timestamp">
        Interrupted response
      </div>
      <template
        v-for="(segment, segmentIndex) in assistantSegments"
        :key="segmentKey(segmentIndex)"
      >
        <div
          v-if="segmentIndex === replySegmentIndex && props.showTimestamp"
          class="message__timestamp"
        >
          {{ messageTimestampLabel }}
        </div>
        <div
          :class="[
            'message__segment',
            {
              'message__segment--bubble': segment.kind !== 'plain',
              'message__segment--error': segment.kind === 'reply' && assistantHasError,
            },
          ]"
        >
          <ReplyActions
            v-if="segmentIndex === replySegmentIndex"
            :copied="copied"
            @copy="copyAssistantMarkdown"
          >
            <slot name="assistant-actions" />
          </ReplyActions>

          <template
            v-for="(block, blockIndex) in segment.blocks"
            :key="`${segmentIndex}-${blockIndex}`"
          >
            <MarkdownBlock v-if="block.type === 'text'" :text="block.text" />
            <TranscriptImage
              v-else-if="block.type === 'image'"
              :src="block.previewUrl ?? imageUrl(block)"
              :original-url="imageUrl(block)"
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
              :suppress-sent-files="block.name === 'attach_files' || block.name === 'subagent'"
              :allow-session-popovers="props.allowSessionPopovers"
            />
          </template>

          <div
            v-if="hasReplyArtifacts && segmentIndex === lastReplySegmentIndex"
            class="message__artifacts"
          >
            <AttachedFilesList v-if="attachedFiles.length > 0" :files="attachedFiles" />
            <SharedSitesList
              v-if="sharedSites.length > 0"
              :sites="sharedSites"
              :id-prefix="props.message.id"
            />
            <button
              v-if="fileChanges.length > 0"
              type="button"
              class="message__diff-button"
              :popovertarget="diffPopoverId"
            >
              <FileDiff :size="16" />
              View changes
              <span class="message__diff-count">{{ fileChanges.length }}</span>
            </button>
            <AgentTurnDiffPopover
              v-if="fileChanges.length > 0"
              :popover-id="diffPopoverId"
              :files="fileChanges"
            />
          </div>
        </div>
      </template>

      <div
        v-if="hasReplyArtifacts && !hasAssistantReplySegment"
        class="message__segment message__segment--bubble message__artifacts"
      >
        <ReplyActions :copied="copied" @copy="copyAssistantMarkdown">
          <slot name="assistant-actions" />
        </ReplyActions>
        <AttachedFilesList v-if="attachedFiles.length > 0" :files="attachedFiles" />
        <SharedSitesList
          v-if="sharedSites.length > 0"
          :sites="sharedSites"
          :id-prefix="props.message.id"
        />
        <button
          v-if="fileChanges.length > 0"
          type="button"
          class="message__diff-button"
          :popovertarget="diffPopoverId"
        >
          <FileDiff :size="16" />
          View changes
          <span class="message__diff-count">{{ fileChanges.length }}</span>
        </button>
        <AgentTurnDiffPopover
          v-if="fileChanges.length > 0"
          :popover-id="diffPopoverId"
          :files="fileChanges"
        />
      </div>

      <template v-if="showAssistantErrorBubble && assistantErrorText">
        <div v-if="props.showTimestamp" class="message__timestamp">{{ messageTimestampLabel }}</div>
        <div class="message__segment message__segment--bubble message__segment--error">
          <ReplyActions
            v-if="!hasReplyArtifacts && !hasAssistantReplySegment"
            :copied="copied"
            @copy="copyAssistantMarkdown"
          >
            <slot name="assistant-actions" />
          </ReplyActions>
          <div class="message__text">{{ assistantErrorText }}</div>
        </div>
      </template>
    </div>

    <div v-else class="message__body">
      <template
        v-for="(block, index) in props.message.blocks"
        :key="`${props.message.id}-${index}`"
      >
        <div v-if="block.type === 'text'" class="message__text">{{ block.text }}</div>
        <TranscriptImage
          v-else-if="block.type === 'image'"
          :src="block.previewUrl ?? imageUrl(block)"
          :original-url="imageUrl(block)"
          :alt="block.name ?? 'Message attachment'"
        />
        <AttachedFilesList
          v-else-if="block.type === 'attachment'"
          :files="[block.file]"
          :preview="false"
          compact
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
          :allow-session-popovers="props.allowSessionPopovers"
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
.message__segment--bubble > :not(.reply-actions) {
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

.message__timestamp {
  justify-self: stretch;
  margin: 0.05rem 0 0.35rem;
  color: color-mix(in srgb, var(--color-text-subtle) 88%, var(--color-text));
  font-family:
    "Source Sans 3",
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
  font-size: 0.82rem;
  font-weight: 600;
  line-height: 1.1;
  text-align: center;
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
  display: flow-root;
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
  --color-bg-inline-code: color-mix(in srgb, var(--color-info-soft) 90%, var(--color-info));
  display: inline-flex;
  align-items: flex-start;
  gap: 0.55rem;
  max-width: 100%;
  padding: 0.5rem 0.65rem;
  border-radius: 0.5rem;
  background: var(--color-info-soft);
  color: var(--color-info);
}

.message__notice-text {
  font-family: var(--font-family-mono);
  font-size: 0.92em;
}

.message__notice-text:has(+ .markdown-body) {
  margin-bottom: 0.55rem;
}

.message__runtime-markdown {
  --color-code-bg: var(--color-bg-inline-code);
  --color-code-border: color-mix(in srgb, var(--color-info-soft) 75%, var(--color-info));
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

.message__notice-files :deep(.attached-files__card),
.message__notice-sites :deep(.shared-sites__card),
.message__notice-sites :deep(.shared-sites__open) {
  border-color: color-mix(in srgb, currentColor 25%, transparent);
  background: var(--color-bg-inline-code);
  color: inherit;
}

.message__notice-files :deep(.attached-files__preview),
.message__notice-files :deep(.transcript-image) {
  background: var(--color-bg-inline-code);
}

.message__notice-files :deep(.attached-files__facts),
.message__notice-files :deep(.attached-files__download),
.message__notice-files :deep(.transcript-image__error),
.message__notice-sites :deep(.shared-sites__meta span) {
  color: inherit;
}

.message__notice-actions {
  margin-top: 0.45rem;
}

.message__artifacts {
  display: grid;
  clear: both;
  gap: 0.6rem;
  margin-top: 0.5rem;
}

.message__segment.message__artifacts {
  display: flow-root;
  margin-top: 0;
}

.message__segment.message__artifacts > :not(.reply-actions) {
  margin-top: 0.6rem;
}

.message__diff-button,
.message__notice-btn {
  justify-self: start;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.42rem 0.65rem;
  min-width: 44px;
  min-height: 44px;
  border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  border-radius: 0.5rem;
  background: var(--color-bg-inline-code);
  color: inherit;
  font-family: inherit;
  cursor: pointer;
}

.message__diff-count {
  min-width: 1.35rem;
  padding: 0.05rem 0.35rem;
  border-radius: 999px;
  background: color-mix(in srgb, currentColor 10%, transparent);
  color: inherit;
  font-size: 0.78rem;
  text-align: center;
}

.message__diff-button:focus-visible,
.message__notice-btn:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 2px;
}

@media (hover: hover) {
  .message__diff-button:hover,
  .message__notice-btn:hover,
  .message__notice-sites :deep(.shared-sites__open:hover) {
    background: color-mix(in srgb, var(--color-bg-inline-code) 90%, currentColor);
  }
}
</style>
