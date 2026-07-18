<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import ChatTranscript from "@/client/components/ChatTranscript.vue";
import { withoutRenderedToolCalls } from "@/client/lib/active-assistant";
import { buildTranscriptDisplayEntries } from "@/client/lib/transcript-display";
import { splitHistoryAndTail } from "@/client/lib/transcript-tail";
import {
  buildToolStateLookup,
  buildTranscriptMessages,
  isAttachmentOutputToolCall,
  mergeAttachmentCarrierIntoAssistant,
  toolStatesForMessage,
} from "@/client/lib/transcript";
import type { SessionState, UiContentBlock } from "@/shared/types";
import type { TranscriptDisplayEntry } from "@/client/lib/transcript-display";
import type { TranscriptMessageView } from "@/client/lib/transcript";

const TRANSCRIPT_BOTTOM_THRESHOLD = 12;
const TRANSCRIPT_LOAD_OLDER_THRESHOLD = 80;
const TRANSCRIPT_TAIL_COUNT = 25;
const USER_SCROLL_INTENT_WINDOW_MS = 1000;
const HISTORY_GESTURE_COOLDOWN_MS = 600;
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
    alwaysShowToolCalls?: boolean;
    allowSessionPopovers?: boolean;
  }>(),
  {
    session: undefined,
    loadingOlderMessages: false,
    alwaysShowToolCalls: false,
    allowSessionPopovers: true,
  },
);

const transcriptPane = ref<ChatTranscriptHandle | null>(null);
const isTranscriptPinnedToBottom = ref(true);
const openToolSectionKey = ref<string | null>(null);
const collapsedToolSectionKey = ref<string | null>(null);
let transcriptScrollElement: HTMLElement | null = null;
let transcriptTailObserver: ResizeObserver | null = null;
let transcriptViewportObserver: ResizeObserver | null = null;
let followTranscriptToken = 0;
let lastUserScrollIntentAt = 0;
let lastHistoryGestureLoadAt = 0;
let historyLoadScheduled = false;
let touchStartX: number | undefined;
let touchStartY: number | undefined;
let touchHistoryLoadRequested = false;
let wheelHistoryLoadLatched = false;
let wheelGestureResetTimeout: number | undefined;

const toolStateLookup = computed(() =>
  buildToolStateLookup(props.session?.messages ?? [], props.session?.activeTools ?? []),
);
const transcriptMessages = computed(() =>
  buildTranscriptMessages(props.session?.messages ?? [], toolStateLookup.value),
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

  if (activeAssistantMessage.value) {
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

const transcriptDisplay = computed(() =>
  buildTranscriptDisplayEntries(
    rawTranscriptEntries.value,
    toolStateLookup.value.toolStatesByCallId,
    {
      alwaysShowToolCalls: props.alwaysShowToolCalls,
      openToolSectionKey: openToolSectionKey.value,
      collapsedToolSectionKey: collapsedToolSectionKey.value,
      showLatestToolToggle: !props.session?.isStreaming,
    },
  ),
);
const latestExpandedSectionKey = computed(() => transcriptDisplay.value.latestExpandedSectionKey);
const transcriptEntries = computed<TranscriptDisplayEntry[]>(() =>
  addTimestampVisibility(transcriptDisplay.value.entries),
);
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
        : `tool-toggle:${entry.sectionKey}:${entry.expanded}`,
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
      return block.data?.length ?? block.url?.length ?? 0;
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

function scheduleOlderMessagesFromGesture(): void {
  if (historyLoadScheduled) {
    return;
  }
  historyLoadScheduled = true;
  requestAnimationFrame(() => {
    historyLoadScheduled = false;
    void maybeLoadOlderMessages();
  });
}

function handleTranscriptWheel(event: WheelEvent): void {
  if (event.deltaY >= 0) {
    markUserScrollIntent();
    return;
  }

  if (wheelGestureResetTimeout !== undefined) {
    window.clearTimeout(wheelGestureResetTimeout);
  }
  wheelGestureResetTimeout = window.setTimeout(() => {
    wheelHistoryLoadLatched = false;
    wheelGestureResetTimeout = undefined;
  }, 180);
  if (wheelHistoryLoadLatched) {
    return;
  }

  wheelHistoryLoadLatched = true;
  markUserScrollIntent();
  isTranscriptPinnedToBottom.value = false;
  stopFollowingTranscript();
  scheduleOlderMessagesFromGesture();
}

function handleTranscriptPointerDown(): void {
  markUserScrollIntent();
}

function handleTranscriptKeyDown(event: KeyboardEvent): void {
  if (event.repeat || !["ArrowUp", "PageUp", "Home"].includes(event.key)) {
    return;
  }
  markUserScrollIntent();
  isTranscriptPinnedToBottom.value = false;
  stopFollowingTranscript();
  scheduleOlderMessagesFromGesture();
}

function handleTranscriptTouchStart(event: TouchEvent): void {
  const touch = event.touches[0];
  touchStartX = touch?.clientX;
  touchStartY = touch?.clientY;
  touchHistoryLoadRequested = false;
  markUserScrollIntent();
  stopFollowingTranscript();
}

function handleTranscriptTouchMove(event: TouchEvent): void {
  const touch = event.touches[0];
  if (
    touchHistoryLoadRequested ||
    !touch ||
    touchStartX === undefined ||
    touchStartY === undefined
  ) {
    return;
  }

  const deltaX = touch.clientX - touchStartX;
  const deltaY = touch.clientY - touchStartY;
  if (deltaY <= 12 || Math.abs(deltaY) <= Math.abs(deltaX)) {
    return;
  }

  touchHistoryLoadRequested = true;
  markUserScrollIntent();
  isTranscriptPinnedToBottom.value = false;
  stopFollowingTranscript();
  scheduleOlderMessagesFromGesture();
}

function handleTranscriptTouchEnd(): void {
  touchStartX = undefined;
  touchStartY = undefined;
  touchHistoryLoadRequested = false;
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
  transcriptScrollElement?.removeEventListener("pointerdown", handleTranscriptPointerDown);
  transcriptScrollElement?.removeEventListener("keydown", handleTranscriptKeyDown);
  transcriptScrollElement?.removeEventListener("touchstart", handleTranscriptTouchStart);
  transcriptScrollElement?.removeEventListener("touchmove", handleTranscriptTouchMove);
  transcriptScrollElement?.removeEventListener("touchend", handleTranscriptTouchEnd);
  transcriptScrollElement?.removeEventListener("touchcancel", handleTranscriptTouchEnd);

  transcriptScrollElement = nextElement;
  transcriptScrollElement?.addEventListener("scroll", handleTranscriptScroll, { passive: true });
  transcriptScrollElement?.addEventListener("wheel", handleTranscriptWheel, { passive: true });
  transcriptScrollElement?.addEventListener("pointerdown", handleTranscriptPointerDown, {
    passive: true,
  });
  transcriptScrollElement?.addEventListener("keydown", handleTranscriptKeyDown);
  transcriptScrollElement?.addEventListener("touchstart", handleTranscriptTouchStart, {
    passive: true,
  });
  transcriptScrollElement?.addEventListener("touchmove", handleTranscriptTouchMove, {
    passive: true,
  });
  transcriptScrollElement?.addEventListener("touchend", handleTranscriptTouchEnd, {
    passive: true,
  });
  transcriptScrollElement?.addEventListener("touchcancel", handleTranscriptTouchEnd, {
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

async function maybeLoadOlderMessages(
  options: { ignoreGestureCooldown?: boolean } = {},
): Promise<void> {
  const element = transcriptRootElement();
  const session = props.session;
  if (
    !element ||
    !session ||
    props.loadingOlderMessages ||
    !session.hasMoreMessages ||
    !hasRecentUserScrollIntent() ||
    (!options.ignoreGestureCooldown &&
      lastHistoryGestureLoadAt > 0 &&
      performance.now() - lastHistoryGestureLoadAt < HISTORY_GESTURE_COOLDOWN_MS) ||
    element.scrollTop > TRANSCRIPT_LOAD_OLDER_THRESHOLD
  ) {
    return;
  }

  const previousScrollTop = element.scrollTop;
  const previousScrollHeight = element.scrollHeight;
  lastUserScrollIntentAt = 0;
  lastHistoryGestureLoadAt = performance.now();
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
}

async function loadOlderFromControl(): Promise<void> {
  markUserScrollIntent();
  isTranscriptPinnedToBottom.value = false;
  stopFollowingTranscript();
  await maybeLoadOlderMessages({ ignoreGestureCooldown: true });
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

function toggleToolCalls(sectionKey: string): void {
  if (sectionKey === latestExpandedSectionKey.value) {
    openToolSectionKey.value = null;
    collapsedToolSectionKey.value =
      collapsedToolSectionKey.value === sectionKey ? null : sectionKey;
    return;
  }

  collapsedToolSectionKey.value = null;
  openToolSectionKey.value = openToolSectionKey.value === sectionKey ? null : sectionKey;
}

onMounted(() => {
  bindTranscriptScrollListener();
  bindTranscriptObservers();
  updateTranscriptPinnedState();
});

onUnmounted(() => {
  stopFollowingTranscript();
  if (wheelGestureResetTimeout !== undefined) {
    window.clearTimeout(wheelGestureResetTimeout);
  }
  transcriptScrollElement?.removeEventListener("scroll", handleTranscriptScroll);
  transcriptScrollElement?.removeEventListener("wheel", handleTranscriptWheel);
  transcriptScrollElement?.removeEventListener("pointerdown", handleTranscriptPointerDown);
  transcriptScrollElement?.removeEventListener("keydown", handleTranscriptKeyDown);
  transcriptScrollElement?.removeEventListener("touchstart", handleTranscriptTouchStart);
  transcriptScrollElement?.removeEventListener("touchmove", handleTranscriptTouchMove);
  transcriptScrollElement?.removeEventListener("touchend", handleTranscriptTouchEnd);
  transcriptScrollElement?.removeEventListener("touchcancel", handleTranscriptTouchEnd);
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
  [() => props.session?.id, latestExpandedSectionKey],
  ([sessionId, sectionKey], [previousSessionId, previousSectionKey]) => {
    if (sessionId !== previousSessionId || sectionKey !== previousSectionKey) {
      openToolSectionKey.value = null;
      collapsedToolSectionKey.value = null;
    }
  },
);

watch(
  [
    () => props.session?.id,
    () => openToolSectionKey.value,
    () => collapsedToolSectionKey.value,
    transcriptTailSignature,
    activeAssistantSignature,
    activeToolsSignature,
  ],
  ([sessionId], [previousSessionId]) => {
    const openedSession = sessionId !== previousSessionId;
    if (openedSession) {
      isTranscriptPinnedToBottom.value = true;
      if (props.session?.isStreaming) {
        void followTranscriptWhilePinned("auto");
      } else {
        void scrollToBottom("auto");
      }
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
    :has-more-messages="Boolean(props.session?.hasMoreMessages)"
    :loading-older-messages="props.loadingOlderMessages"
    @load-older-messages="loadOlderFromControl"
    @jump-to-latest="jumpToLatest"
    :allow-session-popovers="props.allowSessionPopovers"
    @toggle-tool-calls="toggleToolCalls"
  />
</template>
