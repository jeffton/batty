<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import ChatHeader from "@/client/components/ChatHeader.vue";
import ChatTranscript from "@/client/components/ChatTranscript.vue";
import MessageComposer from "@/client/components/MessageComposer.vue";
import { withoutRenderedToolCalls } from "@/client/lib/active-assistant";
import { formatTokenCount } from "@/client/lib/formatting";
import { resolveThinkingOptions } from "@/client/lib/thinking-levels";
import { splitHistoryAndTail } from "@/client/lib/transcript-tail";
import {
  buildToolStateLookup,
  buildTranscriptMessages,
  toolStatesForMessage,
} from "@/client/lib/transcript";
import { useAppStore } from "@/client/stores/app";
import type { UiContentBlock } from "@/shared/types";

const MODEL_POPOVER_ID = "chat-main-model-popover";
const MODEL_POPOVER_ANCHOR = "--chat-main-model-anchor";
const CRON_POPOVER_ID = "chat-main-cron-popover";
const CRON_POPOVER_ANCHOR = "--chat-main-cron-anchor";
const TRANSCRIPT_BOTTOM_THRESHOLD = 12;
const TRANSCRIPT_LOAD_OLDER_THRESHOLD = 80;
const TRANSCRIPT_TAIL_COUNT = 25;
const USER_SCROLL_INTENT_WINDOW_MS = 1000;

type ComposerHandle = InstanceType<typeof MessageComposer> & {
  clear: () => void;
  restore: (text: string, files: File[]) => void;
};

type ChatTranscriptHandle = InstanceType<typeof ChatTranscript> & {
  rootElement: () => HTMLElement | null;
  tailElement: () => HTMLElement | null;
  bottomElement: () => HTMLElement | null;
};

const emit = defineEmits<{
  back: [];
}>();

const store = useAppStore();
const composer = ref<ComposerHandle | null>(null);
const transcriptPane = ref<ChatTranscriptHandle | null>(null);
const isTranscriptPinnedToBottom = ref(true);
let transcriptScrollElement: HTMLElement | null = null;
let transcriptTailObserver: ResizeObserver | null = null;
let transcriptViewportObserver: ResizeObserver | null = null;
let followTranscriptToken = 0;
let lastUserScrollIntentAt = 0;
const thinkingOptions = computed(() => resolveThinkingOptions(store.activeSession));

const toolStateLookup = computed(() =>
  buildToolStateLookup(store.activeSession?.messages ?? [], store.activeSession?.activeTools ?? []),
);
const transcriptMessages = computed(() =>
  buildTranscriptMessages(store.activeSession?.messages ?? [], toolStateLookup.value),
);
const activeAssistantMessage = computed(() =>
  withoutRenderedToolCalls(
    store.activeSession?.activeAssistant,
    toolStateLookup.value.referencedToolCallIds,
  ),
);
const activeAssistantToolStates = computed(() =>
  toolStatesForMessage(activeAssistantMessage.value, toolStateLookup.value.toolStatesByCallId),
);
const transcriptEntries = computed(() => {
  const entries = [...transcriptMessages.value];

  if (activeAssistantMessage.value) {
    entries.push({
      message: activeAssistantMessage.value,
      toolStatesByCallId: activeAssistantToolStates.value,
    });
  }

  return entries;
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
    .map((entry) => `${entry.message.id}:${entry.message.timestamp}`)
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
  (store.activeSession?.activeTools ?? [])
    .map(
      (tool) =>
        `${tool.toolCallId}:${tool.status}:${tool.blocks.length}:${tool.blocks.reduce(
          (total, block) => total + blockContentSize(block),
          0,
        )}`,
    )
    .join("|"),
);
const promptActionPending = ref(false);
const isUnavailable = computed(() => store.connectionState !== "online");
const selectedWorkspaceLoading = computed(() => {
  const workspaceId = store.selectedWorkspaceId;
  if (!workspaceId) {
    return false;
  }

  return Boolean(
    store.loadingWorkspaceSessions[workspaceId] || store.loadingWorkspaceCronJobs[workspaceId],
  );
});
const workspaceSwitcherLoading = computed(() =>
  Boolean(store.routeLoadingWorkspaceId || selectedWorkspaceLoading.value),
);
const sessionLoading = computed(() => Boolean(store.routeLoadingSessionId));
const connectionDescription = computed(() => {
  switch (store.connectionState) {
    case "online":
      return "Connected";
    case "connecting":
      return "Connecting";
    default:
      return "Offline";
  }
});
const contextUsageLabel = computed(() => {
  const session = store.activeSession;
  if (!session) {
    return "ctx ?/? · ?";
  }

  const tokens = session.contextTokens;
  const window = session.contextWindow;
  const percent = session.contextPercent;
  const tokensLabel = tokens == null ? "?" : formatTokenCount(tokens);
  const windowLabel = window == null ? "?" : formatTokenCount(window);
  const percentLabel = percent == null ? "?" : `${percent.toFixed(1)}%`;

  return `ctx ${tokensLabel}/${windowLabel} · ${percentLabel}`;
});
const contextPercentValue = computed(() => {
  const percent = store.activeSession?.contextPercent;
  if (typeof percent !== "number" || !Number.isFinite(percent)) {
    return 0;
  }
  return Math.min(100, Math.max(0, percent));
});
const contextArcStyle = computed(() => {
  const radius = 15.9155;
  const circumference = 2 * Math.PI * radius;
  const progress = circumference * (contextPercentValue.value / 100);

  return {
    strokeDasharray: `${progress} ${circumference}`,
    strokeDashoffset: "0",
  };
});
const contextArcClass = computed(() => {
  if (contextPercentValue.value >= 90) {
    return "header__context-arc--danger";
  }
  if (contextPercentValue.value >= 70) {
    return "header__context-arc--warn";
  }
  return "header__context-arc--good";
});
const currentModelOption = computed(() =>
  store.models.find((model) => model.id === store.activeSession?.model),
);
const modelButtonLabel = computed(() =>
  currentModelOption.value ? shortModelLabel(currentModelOption.value) : "",
);
const thinkingButtonLabel = computed(() =>
  store.activeSession ? thinkingLabel(store.activeSession.thinkingLevel) : "",
);

function shortModelLabel(model: { label: string }): string {
  return model.label.split(" · ", 1)[0] ?? model.label;
}

function thinkingLabel(value: string): string {
  return value === "xhigh" ? "XHigh" : value.charAt(0).toUpperCase() + value.slice(1);
}

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
        if (store.activeSession?.isStreaming) {
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

      if (store.activeSession?.isStreaming) {
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

    if (!store.activeSession?.isStreaming || !isTranscriptPinnedToBottom.value) {
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
  const session = store.activeSession;
  if (
    !element ||
    !session ||
    store.loadingOlderMessages ||
    !session.hasMoreMessages ||
    element.scrollTop > TRANSCRIPT_LOAD_OLDER_THRESHOLD
  ) {
    return;
  }

  const previousScrollTop = element.scrollTop;
  const previousScrollHeight = element.scrollHeight;
  await store.loadOlderMessages();
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
    store.activeSession?.hasMoreMessages
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

function setModel(modelId: string): void {
  if (!modelId) {
    return;
  }

  void store.setModel(modelId);
}

function setThinkingLevel(level: string): void {
  if (!level) {
    return;
  }

  void store.setThinkingLevel(level);
}

function shouldRestoreComposerAfterPromptError(
  before:
    | {
        sessionId: string;
        isStreaming: boolean;
        pendingMessageCount: number;
        updatedAt: number;
        messageCount: number;
      }
    | undefined,
): boolean {
  if (!before) {
    return true;
  }

  const after = store.activeSession;
  if (!after || after.sessionId !== before.sessionId) {
    return true;
  }

  if (!before.isStreaming && after.isStreaming) {
    return false;
  }

  if (after.pendingMessageCount > before.pendingMessageCount) {
    return false;
  }

  if (after.updatedAt > before.updatedAt) {
    return false;
  }

  if (after.messages.length > before.messageCount) {
    return false;
  }

  return true;
}

async function sendPrompt(text: string, files: File[]): Promise<void> {
  const before = store.activeSession
    ? {
        sessionId: store.activeSession.sessionId,
        isStreaming: store.activeSession.isStreaming,
        pendingMessageCount: store.activeSession.pendingMessageCount,
        updatedAt: store.activeSession.updatedAt,
        messageCount: store.activeSession.messages.length,
      }
    : undefined;
  const gateWhileIdle = !store.activeSession?.isStreaming;
  if (gateWhileIdle && promptActionPending.value) {
    return;
  }

  composer.value?.clear();
  if (gateWhileIdle) {
    promptActionPending.value = true;
  }
  try {
    await store.sendPrompt(text, files);
  } catch (error) {
    if (shouldRestoreComposerAfterPromptError(before)) {
      composer.value?.restore(text, files);
    }
    throw error;
  } finally {
    if (gateWhileIdle) {
      promptActionPending.value = false;
    }
  }
}

async function steerPrompt(text: string, files: File[]): Promise<void> {
  const before = store.activeSession
    ? {
        sessionId: store.activeSession.sessionId,
        isStreaming: store.activeSession.isStreaming,
        pendingMessageCount: store.activeSession.pendingMessageCount,
        updatedAt: store.activeSession.updatedAt,
        messageCount: store.activeSession.messages.length,
      }
    : undefined;
  const gateWhileIdle = !store.activeSession?.isStreaming;
  if (gateWhileIdle && promptActionPending.value) {
    return;
  }

  composer.value?.clear();
  if (gateWhileIdle) {
    promptActionPending.value = true;
  }
  try {
    await store.steerPrompt(text, files);
  } catch (error) {
    if (shouldRestoreComposerAfterPromptError(before)) {
      composer.value?.restore(text, files);
    }
    throw error;
  } finally {
    if (gateWhileIdle) {
      promptActionPending.value = false;
    }
  }
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
    () => store.activeSession?.id,
    transcriptTailSignature,
    activeAssistantSignature,
    activeToolsSignature,
  ],
  ([sessionId], [previousSessionId]) => {
    const openedSession = sessionId !== previousSessionId;
    if (openedSession) {
      isTranscriptPinnedToBottom.value = true;
      const followOnOpen = store.activeSession?.isStreaming
        ? followTranscriptWhilePinned("auto")
        : scrollToBottom("auto");
      void followOnOpen.then(() => maybeLoadOlderMessages());
      return;
    }

    if (!isTranscriptPinnedToBottom.value) {
      stopFollowingTranscript();
      return;
    }

    if (store.activeSession?.isStreaming) {
      void followTranscriptWhilePinned("auto");
    } else {
      void scrollToBottom("smooth");
    }
  },
  { flush: "post" },
);
</script>

<template>
  <main class="chat-session-pane">
    <ChatHeader
      :model-popover-id="MODEL_POPOVER_ID"
      :model-popover-anchor="MODEL_POPOVER_ANCHOR"
      :cron-popover-id="CRON_POPOVER_ID"
      :cron-popover-anchor="CRON_POPOVER_ANCHOR"
      :workspace-label="store.selectedWorkspace?.label"
      :cwd="store.activeSession?.cwd"
      :workspace-switcher-loading="workspaceSwitcherLoading"
      :active-session="Boolean(store.activeSession)"
      :models="store.models"
      :current-model-id="store.activeSession?.model"
      :current-thinking-level="store.activeSession?.thinkingLevel ?? 'off'"
      :thinking-options="thinkingOptions"
      :model-button-label="modelButtonLabel"
      :thinking-button-label="thinkingButtonLabel"
      :selected-workspace-id="store.selectedWorkspaceId"
      :context-usage-label="contextUsageLabel"
      :context-arc-class="contextArcClass"
      :context-arc-style="contextArcStyle"
      :connection-state="store.connectionState"
      :connection-description="connectionDescription"
      @back="emit('back')"
      @set-model="setModel"
      @set-thinking-level="setThinkingLevel"
    />

    <div v-if="!store.activeSession && sessionLoading" class="chat-loading">
      <div class="spinner" />
      <p class="muted">Loading session…</p>
    </div>

    <div v-else-if="!store.activeSession" class="chat-empty">
      <img src="/favicon.png" alt="Batty" class="chat-empty__icon" />
      <h3>No active session</h3>
      <p class="muted">Pick a workspace and start a session.</p>
    </div>

    <template v-else>
      <ChatTranscript
        ref="transcriptPane"
        :history-entries="historyEntries"
        :tail-entries="tailEntries"
        :kept-history-indexes="keptHistoryIndexes"
        :is-streaming="store.activeSession.isStreaming"
        :is-pinned-to-bottom="isTranscriptPinnedToBottom"
        @jump-to-latest="jumpToLatest"
      />

      <MessageComposer
        ref="composer"
        :streaming="store.activeSession.isStreaming"
        :session-key="store.activeSession.sessionId"
        :offline="isUnavailable"
        :actions-disabled="isUnavailable"
        @submit="sendPrompt"
        @steer="steerPrompt"
        @stop="store.stopActiveSession"
      />
    </template>
  </main>
</template>

<style scoped>
.chat-session-pane {
  width: 100%;
  height: 100%;
  min-height: 0;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  overflow: hidden;
  background: var(--color-bg-app);
}

.chat-loading,
.chat-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 2rem;
  text-align: center;
}

.chat-empty__icon {
  width: 3.5rem;
  height: 3.5rem;
  border-radius: 0.75rem;
  opacity: 0.6;
}

.chat-empty h3 {
  margin: 0;
  color: var(--color-text-strong);
}

.chat-empty p {
  margin: 0;
}
</style>
