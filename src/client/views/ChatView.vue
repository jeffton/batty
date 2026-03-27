<script setup lang="ts">
import { ChevronDown, Wifi, WifiOff, LoaderCircle, Clock3 } from "lucide-vue-next";
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { VList } from "virtua/vue";
import ChatMessage from "@/client/components/ChatMessage.vue";
import CronPopover from "@/client/components/CronPopover.vue";
import MessageComposer from "@/client/components/MessageComposer.vue";
import ModelConfigPopover from "@/client/components/ModelConfigPopover.vue";
import WorkspacePopover from "@/client/components/WorkspacePopover.vue";
import { withoutRenderedToolCalls } from "@/client/lib/active-assistant";
import { formatTokenCount } from "@/client/lib/formatting";
import { resolveThinkingOptions } from "@/client/lib/thinking-levels";
import {
  buildToolStateLookup,
  buildTranscriptMessages,
  toolStatesForMessage,
} from "@/client/lib/transcript";
import { useAppStore } from "@/client/stores/app";
import type { UiContentBlock } from "@/shared/types";

const WS_POPOVER_ID = "ws-popover";
const WS_POPOVER_ANCHOR = "--ws-anchor";
const MODEL_POPOVER_ID = "chat-main-model-popover";
const MODEL_POPOVER_ANCHOR = "--chat-main-model-anchor";
const CRON_POPOVER_ID = "chat-main-cron-popover";
const CRON_POPOVER_ANCHOR = "--chat-main-cron-anchor";
const TRANSCRIPT_BOTTOM_THRESHOLD = 48;
const TRANSCRIPT_LOAD_OLDER_THRESHOLD = 80;

type TranscriptHandle = InstanceType<typeof VList>;
type ComposerHandle = InstanceType<typeof MessageComposer> & {
  clear: () => void;
  restore: (text: string, files: File[]) => void;
};

const store = useAppStore();
const composer = ref<ComposerHandle | null>(null);
const transcript = ref<TranscriptHandle | null>(null);
const isTranscriptPinnedToBottom = ref(true);
let transcriptScrollElement: HTMLElement | null = null;
let followTranscriptToken = 0;
const thinkingOptions = computed(() => resolveThinkingOptions(store.activeSession, store.models));

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
const keptTranscriptIndexes = computed(() => {
  const lastIndex = transcriptEntries.value.length - 1;
  return lastIndex >= 0 ? [lastIndex] : [];
});
const transcriptTailSignature = computed(() => {
  const lastMessage = transcriptEntries.value.at(-1)?.message;
  return lastMessage
    ? `${transcriptEntries.value.length}:${lastMessage.id}:${lastMessage.timestamp}`
    : "0";
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
  currentModelOption.value ? shortModelLabel(currentModelOption.value) : "Model",
);
const thinkingButtonLabel = computed(() =>
  thinkingLabel(store.activeSession?.thinkingLevel ?? "off"),
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

function updateTranscriptPinnedState(): void {
  const element = transcriptRootElement();
  if (element) {
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    isTranscriptPinnedToBottom.value = distanceFromBottom <= TRANSCRIPT_BOTTOM_THRESHOLD;
    return;
  }

  const handle = transcript.value;
  if (!handle) {
    isTranscriptPinnedToBottom.value = true;
    return;
  }

  const distanceFromBottom = handle.scrollSize - handle.scrollOffset - handle.viewportSize;
  isTranscriptPinnedToBottom.value = distanceFromBottom <= TRANSCRIPT_BOTTOM_THRESHOLD;
}

function transcriptRootElement(): HTMLElement | null {
  return ((transcript.value as (TranscriptHandle & { $el?: Element | null }) | null)?.$el ??
    null) as HTMLElement | null;
}

function stopFollowingTranscript(): void {
  followTranscriptToken += 1;
}

async function followTranscriptWhilePinned(): Promise<void> {
  const token = ++followTranscriptToken;

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
  }
}

function bindTranscriptScrollListener(): void {
  transcriptScrollElement?.removeEventListener("scroll", handleTranscriptScroll);
  transcriptScrollElement = transcriptRootElement();
  transcriptScrollElement?.addEventListener("scroll", handleTranscriptScroll, { passive: true });
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

  let element = transcriptRootElement();
  if (!element) {
    let handle = transcript.value;
    if (!handle) {
      return;
    }

    for (let attempts = 0; attempts < 4 && handle.viewportSize === 0; attempts += 1) {
      await nextAnimationFrame();
      handle = transcript.value;
      if (!handle) {
        return;
      }
    }

    handle.scrollTo(Math.max(0, handle.scrollSize - handle.viewportSize));
  }

  for (let attempts = 0; attempts < 4; attempts += 1) {
    await nextAnimationFrame();
    element = transcriptRootElement();
    if (!element) {
      return;
    }

    const bottomOffset = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTo({ top: bottomOffset, behavior });

    if (Math.abs(bottomOffset - element.scrollTop) <= 1) {
      break;
    }
  }

  updateTranscriptPinnedState();
}

async function maybeLoadOlderMessages(): Promise<void> {
  const handle = transcript.value;
  const session = store.activeSession;
  if (
    !handle ||
    !session ||
    store.loadingOlderMessages ||
    !session.hasMoreMessages ||
    handle.scrollOffset > TRANSCRIPT_LOAD_OLDER_THRESHOLD
  ) {
    return;
  }

  const previousScrollOffset = handle.scrollOffset;
  const previousScrollSize = handle.scrollSize;
  await store.loadOlderMessages();
  await waitForTranscriptLayout();

  const nextHandle = transcript.value;
  if (!nextHandle) {
    return;
  }

  const addedSize = nextHandle.scrollSize - previousScrollSize;
  if (addedSize > 0) {
    nextHandle.scrollTo(previousScrollOffset + addedSize);
  }
  updateTranscriptPinnedState();

  if (
    nextHandle.scrollSize <= nextHandle.viewportSize + TRANSCRIPT_LOAD_OLDER_THRESHOLD &&
    store.activeSession?.hasMoreMessages
  ) {
    await maybeLoadOlderMessages();
  }
}

function handleTranscriptScroll(event?: Event): void {
  updateTranscriptPinnedState();
  if (!isTranscriptPinnedToBottom.value && event?.isTrusted) {
    stopFollowingTranscript();
  }
  void maybeLoadOlderMessages();
}

function closeModelPopover(): void {
  const element = document.getElementById(MODEL_POPOVER_ID) as HTMLElement | null;
  element?.hidePopover?.();
}

function closeWsPopover(): void {
  const element = document.getElementById(WS_POPOVER_ID) as HTMLElement | null;
  element?.hidePopover?.();
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
  window.addEventListener("resize", updateTranscriptPinnedState);
  bindTranscriptScrollListener();
});

onUnmounted(() => {
  window.removeEventListener("resize", updateTranscriptPinnedState);
  transcriptScrollElement?.removeEventListener("scroll", handleTranscriptScroll);
  transcriptScrollElement = null;
  stopFollowingTranscript();
});

watch(transcript, () => {
  bindTranscriptScrollListener();
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
      void scrollToBottom("auto").then(() => {
        if (store.activeSession?.isStreaming) {
          void followTranscriptWhilePinned();
        }
        return maybeLoadOlderMessages();
      });
      return;
    }

    if (!isTranscriptPinnedToBottom.value) {
      stopFollowingTranscript();
      return;
    }

    void scrollToBottom(store.activeSession?.isStreaming ? "auto" : "smooth").then(() => {
      if (store.activeSession?.isStreaming) {
        void followTranscriptWhilePinned();
      }
    });
  },
  { flush: "post" },
);
</script>

<template>
  <main class="chat-view">
    <header class="header">
      <button
        class="header__ws-btn"
        type="button"
        :style="{ 'anchor-name': WS_POPOVER_ANCHOR }"
        :popovertarget="WS_POPOVER_ID"
      >
        <img src="/favicon.png" alt="" class="header__icon" />
        <div class="header__ws-info">
          <span class="header__ws-name">{{ store.selectedWorkspace?.label || "Batty" }}</span>
          <span class="header__ws-path">{{ store.activeSession?.cwd || "Select workspace" }}</span>
        </div>
        <LoaderCircle
          v-if="workspaceSwitcherLoading"
          :size="14"
          class="header__chevron header__status-icon--spin"
        />
        <ChevronDown v-else :size="14" class="header__chevron" />
      </button>

      <WorkspacePopover
        :popover-id="WS_POPOVER_ID"
        :anchor-name="WS_POPOVER_ANCHOR"
        @close="closeWsPopover"
      />

      <button
        class="header__model-btn"
        type="button"
        :style="{ 'anchor-name': MODEL_POPOVER_ANCHOR }"
        :disabled="!store.activeSession"
        :popovertarget="MODEL_POPOVER_ID"
      >
        <div class="header__model-info">
          <span class="header__model-name">{{ modelButtonLabel }}</span>
          <span class="header__model-effort">{{ thinkingButtonLabel }}</span>
        </div>
        <ChevronDown :size="14" class="header__chevron" />
      </button>

      <ModelConfigPopover
        :popover-id="MODEL_POPOVER_ID"
        :anchor-name="MODEL_POPOVER_ANCHOR"
        :models="store.models"
        :current-model-id="store.activeSession?.model"
        :current-thinking-level="store.activeSession?.thinkingLevel ?? 'off'"
        :thinking-options="thinkingOptions"
        @set-model="setModel"
        @set-thinking-level="setThinkingLevel"
        @close="closeModelPopover"
      />

      <button
        class="header__icon-btn"
        type="button"
        :style="{ 'anchor-name': CRON_POPOVER_ANCHOR }"
        :disabled="!store.selectedWorkspaceId"
        :popovertarget="CRON_POPOVER_ID"
        aria-label="Cron jobs"
        title="Cron jobs"
      >
        <Clock3 :size="15" />
      </button>

      <CronPopover :popover-id="CRON_POPOVER_ID" :anchor-name="CRON_POPOVER_ANCHOR" />

      <div class="header__spacer" />

      <div class="header__context" :aria-label="contextUsageLabel" :title="contextUsageLabel">
        <svg class="header__context-chart" viewBox="0 0 36 36" aria-hidden="true">
          <circle class="header__context-track" cx="18" cy="18" r="15.9155" />
          <circle
            :class="['header__context-arc', contextArcClass]"
            :style="contextArcStyle"
            cx="18"
            cy="18"
            r="15.9155"
          />
        </svg>
      </div>

      <span
        class="header__status"
        :aria-label="connectionDescription"
        :title="connectionDescription"
      >
        <Wifi
          v-if="store.connectionState === 'online'"
          :size="15"
          class="header__status-icon header__status-icon--online"
        />
        <LoaderCircle
          v-else-if="store.connectionState === 'connecting'"
          :size="15"
          class="header__status-icon header__status-icon--connecting header__status-icon--spin"
        />
        <WifiOff v-else :size="15" class="header__status-icon header__status-icon--offline" />
      </span>
    </header>

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
      <VList
        ref="transcript"
        class="transcript"
        :data="transcriptEntries"
        :keep-mounted="keptTranscriptIndexes"
      >
        <template #default="{ item: entry }">
          <div :key="entry.message.id" class="transcript__item">
            <ChatMessage
              :message="entry.message"
              :tool-states-by-call-id="entry.toolStatesByCallId"
            />
          </div>
        </template>
      </VList>

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
.chat-view {
  width: 100%;
  height: 100%;
  min-height: 0;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  overflow: hidden;
  background: var(--color-bg-app);
}

.header {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  padding: calc(var(--safe-area-top) + 0.4rem) calc(var(--safe-area-right) + 0.6rem) 0.4rem
    calc(var(--safe-area-left) + 0.6rem);
  background: var(--color-bg-panel);
  border-bottom: 1px solid var(--color-border-soft);
}

.header__icon {
  width: 1.6rem;
  height: 1.6rem;
  border-radius: 0.35rem;
  flex-shrink: 0;
}

.header__ws-btn {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  border: 0;
  border-radius: 0.5rem;
  background: transparent;
  color: inherit;
  padding: 0.3rem 0.45rem;
  min-width: 0;
  text-align: left;
  transition: background 80ms ease;
}

.header__ws-btn:hover {
  background: var(--color-bg-elevated);
}

.header__ws-info {
  display: flex;
  flex-direction: column;
  min-width: 0;
  line-height: 1.25;
  text-align: left;
}

.header__ws-name {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--color-text-strong);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header__ws-path {
  font-size: 0.75rem;
  color: var(--color-text-subtle);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header__chevron {
  color: var(--color-text-subtle);
  flex-shrink: 0;
}

.header__model-btn {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  border: 0;
  border-radius: 0.5rem;
  background: transparent;
  color: inherit;
  padding: 0.3rem 0.45rem;
  min-width: 0;
  transition: background 80ms ease;
}

.header__model-btn:hover:not(:disabled) {
  background: var(--color-bg-elevated);
}

.header__model-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.header__model-info {
  display: flex;
  flex-direction: column;
  min-width: 0;
  line-height: 1.25;
  text-align: left;
}

.header__icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  border: 0;
  border-radius: 0.5rem;
  background: transparent;
  color: var(--color-text-subtle);
  transition: background 80ms ease;
}

.header__icon-btn:hover:not(:disabled) {
  background: var(--color-bg-elevated);
}

.header__icon-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.header__model-name {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--color-text-strong);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header__model-effort {
  font-size: 0.75rem;
  color: var(--color-text-subtle);
}

.header__spacer {
  flex: 1;
}

.header__context {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.6rem;
  height: 1.6rem;
  flex-shrink: 0;
}

.header__context-chart {
  width: 1.15rem;
  height: 1.15rem;
  transform: rotate(-90deg);
}

.header__context-track,
.header__context-arc {
  fill: none;
  stroke-width: 3.2;
}

.header__context-track {
  stroke: var(--color-border-soft);
}

.header__context-arc {
  stroke-linecap: round;
  transition:
    stroke-dasharray 180ms ease,
    stroke 180ms ease;
}

.header__context-arc--good {
  stroke: var(--color-success);
}

.header__context-arc--warn {
  stroke: var(--color-warning);
}

.header__context-arc--danger {
  stroke: var(--color-error);
}

.header__status {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.6rem;
  height: 1.6rem;
  flex-shrink: 0;
}

.header__status-icon--online {
  color: var(--color-success);
}

.header__status-icon--connecting {
  color: var(--color-text-subtle);
}

.header__status-icon--offline {
  color: var(--color-warning);
}

.header__status-icon--spin {
  animation: header-spin 0.9s linear infinite;
}

@keyframes header-spin {
  to {
    transform: rotate(360deg);
  }
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

.transcript {
  min-height: 0;
  min-width: 0;
  overflow: auto;
  padding: 0.6rem calc(var(--safe-area-right) + 0.8rem) 0.2rem calc(var(--safe-area-left) + 0.8rem);
  background: var(--color-bg-app);
}

.transcript__item {
  min-width: 0;
  padding-bottom: 0.5rem;
}
</style>
