<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import ChatTranscript from "@/client/components/ChatTranscript.vue";
import { NO_REPLY_SENTINEL } from "@/shared/agent-notification";
import { withoutRenderedToolCalls } from "@/client/lib/active-assistant";
import { easyModeMessage } from "@/client/lib/easy-mode";
import { splitHistoryAndTail } from "@/client/lib/transcript-tail";
import {
  buildToolStateLookup,
  buildTranscriptMessages,
  isAttachmentOutputToolCall,
  mergeAttachmentCarrierIntoAssistant,
  toolStatesForMessage,
} from "@/client/lib/transcript";
import type { SessionState, UiContentBlock } from "@/shared/types";
import type { TranscriptMessageView } from "@/client/lib/transcript";
import type { TranscriptDisplayEntry } from "@/client/components/ChatTranscript.vue";

const TRANSCRIPT_BOTTOM_THRESHOLD = 12;
const TRANSCRIPT_LOAD_OLDER_THRESHOLD = 80;
const TRANSCRIPT_TAIL_COUNT = 25;
const USER_SCROLL_INTENT_WINDOW_MS = 1000;
const TIMESTAMP_GROUP_WINDOW_MS = 10 * 60 * 1000;

type ChatTranscriptHandle = InstanceType<typeof ChatTranscript> & {
  rootElement: () => HTMLElement | null;
  tailElement: () => HTMLElement | null;
  bottomElement: () => HTMLElement | null;
};

const props = withDefaults(
  defineProps<{
    session?: SessionState;
    loadOlderMessages: () => Promise<void>;
    loadingOlderMessages?: boolean;
  }>(),
  {
    session: undefined,
    loadingOlderMessages: false,
  },
);

const transcriptPane = ref<ChatTranscriptHandle | null>(null);
const isTranscriptPinnedToBottom = ref(true);
const showAllToolCalls = ref(false);
let transcriptScrollElement: HTMLElement | null = null;
let transcriptTailObserver: ResizeObserver | null = null;
let transcriptViewportObserver: ResizeObserver | null = null;
let followTranscriptToken = 0;
let lastUserScrollIntentAt = 0;

const toolStateLookup = computed(() =>
  buildToolStateLookup(props.session?.messages ?? [], props.session?.activeTools ?? []),
);
const transcriptMessages = computed(() =>
  buildTranscriptMessages(props.session?.messages ?? [], toolStateLookup.value).filter(
    (entry) => !isNoReplyAssistant(entry.message),
  ),
);
const activeAssistantMessage = computed(() =>
  withoutRenderedToolCalls(
    props.session?.activeAssistant?.role === "assistant"
      ? props.session.activeAssistant
      : undefined,
    toolStateLookup.value.referencedToolCallIds,
  ),
);
const rawTranscriptEntries = computed<TranscriptMessageView[]>(() => {
  const entries = [...transcriptMessages.value];

  if (activeAssistantMessage.value && !isNoReplyAssistant(activeAssistantMessage.value)) {
    const lastEntry = entries.at(-1);
    const lastMessage = lastEntry?.message;
    const attachmentBlocks =
      lastMessage?.role === "assistant" &&
      lastMessage.blocks.length > 0 &&
      lastMessage.blocks.every((block) =>
        isAttachmentOutputToolCall(block, toolStateLookup.value.toolStatesByCallId),
      )
        ? lastMessage.blocks
        : [];

    if (attachmentBlocks.length > 0) {
      entries.pop();
    }

    const message =
      attachmentBlocks.length > 0
        ? mergeAttachmentCarrierIntoAssistant(activeAssistantMessage.value, attachmentBlocks)
        : activeAssistantMessage.value;

    entries.push({
      message,
      toolStatesByCallId: toolStatesForMessage(message, toolStateLookup.value.toolStatesByCallId),
    });
  }

  return entries;
});

function assistantText(
  message: Extract<SessionState["messages"][number], { role: "assistant" }>,
): string {
  return message.blocks
    .map((block) =>
      block.type === "text" ? block.text : block.type === "thinking" ? block.thinking : "",
    )
    .join("")
    .trim();
}

function isNoReplyAssistant(message: SessionState["messages"][number] | undefined): boolean {
  return message?.role === "assistant" && assistantText(message) === NO_REPLY_SENTINEL;
}

function isTurnStart(entry: TranscriptMessageView): boolean {
  return entry.message.role === "user" || entry.message.role === "custom";
}

function latestTurnStartIndex(entries: TranscriptMessageView[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (isTurnStart(entries[index] as TranscriptMessageView)) {
      return index;
    }
  }

  return Math.max(0, entries.length - 1);
}

function collapsedMessage(entry: TranscriptMessageView): TranscriptMessageView | undefined {
  const message = easyModeMessage(entry.message, toolStateLookup.value.toolStatesByCallId);
  return message ? { ...entry, message } : undefined;
}

function hidesToolDetails(
  original: TranscriptMessageView,
  collapsed: TranscriptMessageView | undefined,
): boolean {
  if (!collapsed) {
    return true;
  }

  if (!("blocks" in original.message) || !("blocks" in collapsed.message)) {
    return false;
  }

  return original.message.blocks.length !== collapsed.message.blocks.length;
}

function canShowTimestamp(entry: TranscriptMessageView): boolean {
  const message = entry.message;
  if (message.role === "user") {
    return true;
  }

  return (
    message.role === "assistant" &&
    message.blocks.some((block) => block.type === "text" || block.type === "image")
  );
}

function addTimestampVisibility(entries: TranscriptDisplayEntry[]): TranscriptDisplayEntry[] {
  let previousTimestamp: number | undefined;

  return entries.map((entry) => {
    if (entry.kind !== "message" || !canShowTimestamp(entry.entry)) {
      return entry;
    }

    const timestamp = entry.entry.message.timestamp;
    const showTimestamp =
      previousTimestamp === undefined || timestamp - previousTimestamp >= TIMESTAMP_GROUP_WINDOW_MS;
    previousTimestamp = timestamp;
    return { ...entry, showTimestamp };
  });
}

const transcriptEntries = computed<TranscriptDisplayEntry[]>(() => {
  const entries = rawTranscriptEntries.value;
  const latestTurnIndex = latestTurnStartIndex(entries);
  const collapsedByIndex = entries.map((entry, index) =>
    index >= latestTurnIndex ? entry : collapsedMessage(entry),
  );
  const latestHiddenIndex = collapsedByIndex.reduce(
    (latest, collapsed, index) =>
      index < latestTurnIndex &&
      hidesToolDetails(entries[index] as TranscriptMessageView, collapsed)
        ? index
        : latest,
    -1,
  );

  const displayEntries: TranscriptDisplayEntry[] = [];
  entries.forEach((entry, index) => {
    const visibleEntry = showAllToolCalls.value ? entry : collapsedByIndex[index];
    if (visibleEntry) {
      displayEntries.push({ kind: "message", entry: visibleEntry, showTimestamp: false });
    }
    if (index === latestHiddenIndex) {
      displayEntries.push({ kind: "tool-toggle", expanded: showAllToolCalls.value });
    }
  });

  return addTimestampVisibility(displayEntries);
});
const transcriptSplit = computed(() =>
  splitHistoryAndTail(transcriptEntries.value, TRANSCRIPT_TAIL_COUNT),
);
const historyEntries = computed(() => transcriptSplit.value.historyEntries);
const tailEntries = computed(() => transcriptSplit.value.tailEntries);
const keptHistoryIndexes = computed(() => {
  const lastIndex = historyEntries.value.length - 1;
  return lastIndex >= 0 ? [lastIndex] : [];
});
const transcriptTailSignature = computed(() => {
  if (tailEntries.value.length === 0) {
    return "0";
  }

  return tailEntries.value
    .map((entry) =>
      entry.kind === "message"
        ? `${entry.entry.message.id}:${entry.entry.message.timestamp}`
        : `tool-toggle:${entry.expanded}`,
    )
    .join("|");
});
const activeAssistantSignature = computed(() => {
  const assistant = activeAssistantMessage.value;
  if (!assistant) {
    return "";
  }

  return `${assistant.id}:${assistant.timestamp}:${assistant.blocks.reduce(
    (total, block) => total + blockContentSize(block),
    0,
  )}`;
});
const activeToolsSignature = computed(() =>
  (props.session?.activeTools ?? [])
    .map(
      (tool) =>
        `${tool.toolCallId}:${tool.status}:${tool.blocks.length}:${tool.blocks.reduce(
          (total, block) => total + blockContentSize(block),
          0,
        )}`,
    )
    .join("|"),
);

function blockContentSize(block: UiContentBlock): number {
  switch (block.type) {
    case "text":
      return block.text.length;
    case "thinking":
      return block.thinking.length;
    case "image":
      return block.data.length;
    case "toolCall":
      return block.id.length + block.name.length;
  }
}

function transcriptRootElement(): HTMLElement | null {
  return transcriptPane.value?.rootElement() ?? null;
}

function transcriptTailElement(): HTMLElement | null {
  return transcriptPane.value?.tailElement() ?? null;
}

function transcriptBottomElement(): HTMLElement | null {
  return transcriptPane.value?.bottomElement() ?? null;
}

function transcriptDistanceFromBottom(): number | null {
  const element = transcriptRootElement();
  if (!element) {
    return null;
  }

  return element.scrollHeight - element.scrollTop - element.clientHeight;
}

function updateTranscriptPinnedState(): void {
  const distanceFromBottom = transcriptDistanceFromBottom();
  if (distanceFromBottom == null) {
    isTranscriptPinnedToBottom.value = true;
    return;
  }

  if (distanceFromBottom <= TRANSCRIPT_BOTTOM_THRESHOLD) {
    isTranscriptPinnedToBottom.value = true;
    return;
  }

  if (hasRecentUserScrollIntent()) {
    isTranscriptPinnedToBottom.value = false;
  }
}

function stopFollowingTranscript(): void {
  followTranscriptToken += 1;
}

function markUserScrollIntent(): void {
  lastUserScrollIntentAt = performance.now();
}

function handleTranscriptWheel(event: WheelEvent): void {
  markUserScrollIntent();
  if (event.deltaY < 0) {
    isTranscriptPinnedToBottom.value = false;
    stopFollowingTranscript();
  }
}

function handleTranscriptTouchStart(): void {
  markUserScrollIntent();
  stopFollowingTranscript();
}

function handleTranscriptTouchMove(): void {
  markUserScrollIntent();
  isTranscriptPinnedToBottom.value = false;
  stopFollowingTranscript();
}

function hasRecentUserScrollIntent(): boolean {
  return (
    lastUserScrollIntentAt > 0 &&
    performance.now() - lastUserScrollIntentAt <= USER_SCROLL_INTENT_WINDOW_MS
  );
}

function bindTranscriptScrollListener(): void {
  const nextElement = transcriptRootElement();
  if (transcriptScrollElement === nextElement) {
    return;
  }

  transcriptScrollElement?.removeEventListener("scroll", handleTranscriptScroll);
  transcriptScrollElement?.removeEventListener("wheel", handleTranscriptWheel);
  transcriptScrollElement?.removeEventListener("touchstart", handleTranscriptTouchStart);
  transcriptScrollElement?.removeEventListener("touchmove", handleTranscriptTouchMove);

  transcriptScrollElement = nextElement;
  transcriptScrollElement?.addEventListener("scroll", handleTranscriptScroll, { passive: true });
  transcriptScrollElement?.addEventListener("wheel", handleTranscriptWheel, { passive: true });
  transcriptScrollElement?.addEventListener("touchstart", handleTranscriptTouchStart, {
    passive: true,
  });
  transcriptScrollElement?.addEventListener("touchmove", handleTranscriptTouchMove, {
    passive: true,
  });
}

function bindTranscriptObservers(): void {
  transcriptViewportObserver?.disconnect();
  transcriptViewportObserver = null;

  const transcriptElement = transcriptRootElement();
  if (transcriptElement && typeof ResizeObserver !== "undefined") {
    transcriptViewportObserver = new ResizeObserver(() => {
      if (isTranscriptPinnedToBottom.value) {
        if (props.session?.isStreaming) {
          void followTranscriptWhilePinned("auto");
        } else {
          void scrollToBottom("auto");
        }
        return;
      }

      updateTranscriptPinnedState();
    });
    transcriptViewportObserver.observe(transcriptElement);
  }

  transcriptTailObserver?.disconnect();
  transcriptTailObserver = null;

  const tailElement = transcriptTailElement();
  if (tailElement && typeof ResizeObserver !== "undefined") {
    transcriptTailObserver = new ResizeObserver(() => {
      if (!isTranscriptPinnedToBottom.value) {
        return;
      }

      if (props.session?.isStreaming) {
        void followTranscriptWhilePinned("auto");
      } else {
        void scrollToBottom("auto");
      }
    });
    transcriptTailObserver.observe(tailElement);
  }
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function waitForTranscriptLayout(): Promise<void> {
  await nextTick();
  await nextAnimationFrame();
}

async function scrollToBottom(behavior: ScrollBehavior = "auto"): Promise<void> {
  if (transcriptEntries.value.length === 0) {
    return;
  }

  await waitForTranscriptLayout();

  const element = transcriptRootElement();
  if (!element) {
    return;
  }

  for (let attempts = 0; attempts < 3; attempts += 1) {
    const scrollBehavior = attempts === 0 ? behavior : "auto";
    const bottomOffset = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTo({ top: bottomOffset, behavior: scrollBehavior });

    await nextAnimationFrame();

    const bottomElement = transcriptBottomElement();
    if (bottomElement) {
      const transcriptRect = element.getBoundingClientRect();
      const sentinelRect = bottomElement.getBoundingClientRect();
      const sentinelDistanceFromBottom = transcriptRect.bottom - sentinelRect.bottom;
      if (sentinelDistanceFromBottom < 0) {
        element.scrollBy({ top: -sentinelDistanceFromBottom, behavior: "auto" });
        await nextAnimationFrame();
      }
    }

    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (distanceFromBottom <= 1) {
      break;
    }
  }

  isTranscriptPinnedToBottom.value = true;
}

async function followTranscriptWhilePinned(behavior: ScrollBehavior = "auto"): Promise<void> {
  if (!isTranscriptPinnedToBottom.value) {
    return;
  }

  const token = ++followTranscriptToken;
  await scrollToBottom(behavior);

  while (token === followTranscriptToken) {
    await nextAnimationFrame();

    if (!props.session?.isStreaming || !isTranscriptPinnedToBottom.value) {
      return;
    }

    const element = transcriptRootElement();
    if (!element) {
      return;
    }

    const bottomOffset = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTop = bottomOffset;

    const bottomElement = transcriptBottomElement();
    if (bottomElement) {
      const transcriptRect = element.getBoundingClientRect();
      const sentinelRect = bottomElement.getBoundingClientRect();
      const sentinelDistanceFromBottom = transcriptRect.bottom - sentinelRect.bottom;
      if (sentinelDistanceFromBottom < 0) {
        element.scrollTop += -sentinelDistanceFromBottom;
      }
    }
  }
}

async function maybeLoadOlderMessages(): Promise<void> {
  const element = transcriptRootElement();
  const session = props.session;
  if (
    !element ||
    !session ||
    props.loadingOlderMessages ||
    !session.hasMoreMessages ||
    element.scrollTop > TRANSCRIPT_LOAD_OLDER_THRESHOLD
  ) {
    return;
  }

  const previousScrollTop = element.scrollTop;
  const previousScrollHeight = element.scrollHeight;
  await props.loadOlderMessages();
  await waitForTranscriptLayout();

  const nextElement = transcriptRootElement();
  if (!nextElement) {
    return;
  }

  const addedHeight = nextElement.scrollHeight - previousScrollHeight;
  if (addedHeight > 0) {
    nextElement.scrollTop = previousScrollTop + addedHeight;
  }
  updateTranscriptPinnedState();

  if (
    nextElement.scrollHeight <= nextElement.clientHeight + TRANSCRIPT_LOAD_OLDER_THRESHOLD &&
    props.session?.hasMoreMessages
  ) {
    await maybeLoadOlderMessages();
  }
}

function handleTranscriptScroll(): void {
  updateTranscriptPinnedState();
  if (!isTranscriptPinnedToBottom.value && hasRecentUserScrollIntent()) {
    stopFollowingTranscript();
  }
  void maybeLoadOlderMessages();
}

async function jumpToLatest(): Promise<void> {
  isTranscriptPinnedToBottom.value = true;
  await scrollToBottom("smooth");
}

onMounted(() => {
  bindTranscriptScrollListener();
  bindTranscriptObservers();
  updateTranscriptPinnedState();
});

onUnmounted(() => {
  stopFollowingTranscript();
  transcriptScrollElement?.removeEventListener("scroll", handleTranscriptScroll);
  transcriptScrollElement?.removeEventListener("wheel", handleTranscriptWheel);
  transcriptScrollElement?.removeEventListener("touchstart", handleTranscriptTouchStart);
  transcriptScrollElement?.removeEventListener("touchmove", handleTranscriptTouchMove);
  transcriptScrollElement = null;
  transcriptViewportObserver?.disconnect();
  transcriptTailObserver?.disconnect();
});

watch(transcriptPane, () => {
  bindTranscriptScrollListener();
  bindTranscriptObservers();
  updateTranscriptPinnedState();
});

watch(
  [
    () => props.session?.id,
    () => showAllToolCalls.value,
    transcriptTailSignature,
    activeAssistantSignature,
    activeToolsSignature,
  ],
  ([sessionId], [previousSessionId]) => {
    const openedSession = sessionId !== previousSessionId;
    if (openedSession) {
      isTranscriptPinnedToBottom.value = true;
      const followOnOpen = props.session?.isStreaming
        ? followTranscriptWhilePinned("auto")
        : scrollToBottom("auto");
      void followOnOpen.then(() => maybeLoadOlderMessages());
      return;
    }

    if (!isTranscriptPinnedToBottom.value) {
      stopFollowingTranscript();
      return;
    }

    if (props.session?.isStreaming) {
      void followTranscriptWhilePinned("auto");
    } else {
      void scrollToBottom("smooth");
    }
  },
  { flush: "post" },
);
</script>

<template>
  <ChatTranscript
    ref="transcriptPane"
    :history-entries="historyEntries"
    :tail-entries="tailEntries"
    :kept-history-indexes="keptHistoryIndexes"
    :is-streaming="Boolean(props.session?.isStreaming)"
    :is-pinned-to-bottom="isTranscriptPinnedToBottom"
    @jump-to-latest="jumpToLatest"
    @toggle-tool-calls="showAllToolCalls = !showAllToolCalls"
  />
</template>
