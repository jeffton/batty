<script setup lang="ts">
import { LoaderCircle, Menu, Wifi, WifiOff } from "lucide-vue-next";
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { VList } from "virtua/vue";
import ChatMessage from "@/client/components/ChatMessage.vue";
import MessageComposer from "@/client/components/MessageComposer.vue";
import ModelConfigPopover from "@/client/components/ModelConfigPopover.vue";
import SessionSidebar from "@/client/components/SessionSidebar.vue";
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

const MODEL_POPOVER_ID = "chat-main-model-popover";
const MODEL_POPOVER_ANCHOR = "--chat-main-model-anchor";
const TRANSCRIPT_BOTTOM_THRESHOLD = 24;

type TranscriptHandle = InstanceType<typeof VList>;

const store = useAppStore();
const transcript = ref<TranscriptHandle | null>(null);
const isTranscriptPinnedToBottom = ref(true);
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
    return "chat-main__context-arc--danger";
  }
  if (contextPercentValue.value >= 70) {
    return "chat-main__context-arc--warn";
  }
  return "chat-main__context-arc--good";
});
const currentModelOption = computed(() =>
  store.models.find((model) => model.id === store.activeSession?.model),
);
const modelThinkingButtonLabel = computed(() => {
  const modelLabel = currentModelOption.value ? shortModelLabel(currentModelOption.value) : "Model";
  const levelLabel = thinkingLabel(store.activeSession?.thinkingLevel ?? "off");
  return `${modelLabel} · ${levelLabel}`;
});

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
  const handle = transcript.value;
  if (!handle) {
    isTranscriptPinnedToBottom.value = true;
    return;
  }

  const distanceFromBottom = handle.scrollSize - handle.scrollOffset - handle.viewportSize;
  isTranscriptPinnedToBottom.value = distanceFromBottom <= TRANSCRIPT_BOTTOM_THRESHOLD;
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function waitForTranscriptLayout(): Promise<void> {
  await nextTick();
  await nextAnimationFrame();
}

async function scrollToBottom(behavior: ScrollBehavior = "auto"): Promise<void> {
  const handle = transcript.value;
  const lastIndex = transcriptEntries.value.length - 1;
  if (!handle || lastIndex < 0) {
    return;
  }

  await waitForTranscriptLayout();
  transcript.value?.scrollToIndex(lastIndex, {
    align: "end",
    smooth: behavior === "smooth",
  });
  await nextAnimationFrame();
  updateTranscriptPinnedState();
}

function handleTranscriptScroll(): void {
  updateTranscriptPinnedState();
}

function closeModelPopover(): void {
  const element = document.getElementById(MODEL_POPOVER_ID) as HTMLElement | null;
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

onMounted(() => {
  window.addEventListener("resize", updateTranscriptPinnedState);
});

onUnmounted(() => {
  window.removeEventListener("resize", updateTranscriptPinnedState);
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
      void scrollToBottom("auto");
      return;
    }

    if (!isTranscriptPinnedToBottom.value) {
      return;
    }

    void scrollToBottom(store.activeSession?.isStreaming ? "auto" : "smooth");
  },
);
</script>

<template>
  <main class="chat-view">
    <SessionSidebar />
    <section class="chat-main">
      <header class="chat-main__header panel">
        <button
          class="chat-main__menu"
          type="button"
          aria-label="Open sidebar"
          title="Open sidebar"
          @click="store.mobileSidebarOpen = true"
        >
          <Menu :size="18" aria-hidden="true" />
        </button>
        <div class="chat-main__heading">
          <h2>{{ store.selectedWorkspace?.label || "Choose a workspace" }}</h2>
          <p class="muted">
            {{ store.activeSession?.cwd || "Pick a folder and start a session." }}
          </p>
        </div>
        <div class="chat-main__toolbar">
          <span
            class="chat-main__status"
            :aria-label="connectionDescription"
            :title="connectionDescription"
          >
            <Wifi
              v-if="store.connectionState === 'online'"
              :size="16"
              class="chat-main__status-icon chat-main__status-icon--online"
            />
            <LoaderCircle
              v-else-if="store.connectionState === 'connecting'"
              :size="16"
              class="chat-main__status-icon chat-main__status-icon--connecting chat-main__status-icon--spin"
            />
            <WifiOff
              v-else
              :size="16"
              class="chat-main__status-icon chat-main__status-icon--offline"
            />
          </span>
          <div
            class="chat-main__context"
            :aria-label="contextUsageLabel"
            :title="contextUsageLabel"
          >
            <svg class="chat-main__context-chart" viewBox="0 0 36 36" aria-hidden="true">
              <circle class="chat-main__context-track" cx="18" cy="18" r="15.9155" />
              <circle
                :class="['chat-main__context-arc', contextArcClass]"
                :style="contextArcStyle"
                cx="18"
                cy="18"
                r="15.9155"
              />
            </svg>
          </div>
          <button
            class="chat-main__config-button"
            type="button"
            :style="{ 'anchor-name': MODEL_POPOVER_ANCHOR }"
            :disabled="!store.activeSession"
            :popovertarget="MODEL_POPOVER_ID"
          >
            {{ modelThinkingButtonLabel }}
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
        </div>
      </header>

      <div v-if="!store.activeSession" class="chat-main__empty panel">
        <h3>No active session yet</h3>
        <p class="muted">
          Pick a workspace on the left, then start a fresh session or resume one of the recent
          sessions.
        </p>
      </div>

      <template v-else>
        <VList
          ref="transcript"
          class="chat-main__transcript panel"
          :data="transcriptEntries"
          :keep-mounted="keptTranscriptIndexes"
          @scroll="handleTranscriptScroll"
        >
          <template #default="{ item: entry }">
            <div :key="entry.message.id" class="chat-main__transcript-item">
              <ChatMessage
                :message="entry.message"
                :tool-states-by-call-id="entry.toolStatesByCallId"
              />
            </div>
          </template>
        </VList>

        <MessageComposer
          :streaming="store.activeSession.isStreaming"
          @submit="(text, files) => store.sendPrompt(text, files)"
          @steer="(text, files) => store.steerPrompt(text, files)"
          @stop="store.stopActiveSession"
        />
      </template>
    </section>
  </main>
</template>

<style scoped>
.chat-view {
  width: 100%;
  height: 100%;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(15rem, 17rem) minmax(0, 1fr);
  gap: 0;
  overflow: hidden;
  background: var(--color-bg-app);
}

.chat-main {
  min-width: 0;
  min-height: 0;
  display: grid;
  gap: 0;
  grid-template-rows: auto minmax(0, 1fr) auto;
  overflow: hidden;
}

.chat-main__header {
  min-width: 0;
  padding: calc(var(--safe-area-top) + 0.42rem) calc(var(--safe-area-right) + 0.7rem) 0.42rem 0.7rem;
  display: flex;
  gap: 0.45rem;
  align-items: center;
  justify-content: space-between;
  border: 0;
  border-radius: 0;
  box-shadow: none;
  backdrop-filter: none;
  border-bottom: 1px solid var(--color-border-soft);
  background: var(--color-bg-overlay);
}

.chat-main__heading {
  min-width: 0;
  display: grid;
  gap: 0;
}

.chat-main__header h2,
.chat-main__header p,
.chat-main__empty h3,
.chat-main__empty p {
  margin: 0;
}

.chat-main__header h2 {
  font-size: 1rem;
}

.chat-main__heading p {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-main__toolbar {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.25rem;
  flex-wrap: nowrap;
  justify-content: flex-end;
}

.chat-main__menu,
.chat-main__status,
.chat-main__context,
.chat-main__config-button {
  font-size: 0.88rem;
}

.chat-main__menu,
.chat-main__config-button {
  border-radius: 0.4rem;
  border: 1px solid var(--color-border-strong);
  background: var(--color-bg-elevated);
  color: inherit;
  padding: 0.34rem 0.48rem;
}

.chat-main__menu {
  display: none;
}

.chat-main__status,
.chat-main__context {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.8rem;
  height: 1.8rem;
  border-radius: 999px;
  border: 1px solid var(--color-border-soft);
  background: var(--color-bg-panel);
  color: var(--color-text-muted);
  flex: 0 0 auto;
}

.chat-main__status-icon--online {
  color: var(--color-success);
}

.chat-main__status-icon--connecting {
  color: var(--color-text-subtle);
}

.chat-main__status-icon--offline {
  color: var(--color-warning);
}

.chat-main__status-icon--spin {
  animation: chat-main-spin 0.9s linear infinite;
}

.chat-main__context-chart {
  width: 1rem;
  height: 1rem;
  transform: rotate(-90deg);
}

.chat-main__context-track,
.chat-main__context-arc {
  fill: none;
  stroke-width: 3.2;
}

.chat-main__context-track {
  stroke: var(--color-border-strong);
}

.chat-main__context-arc {
  stroke-linecap: round;
  transition:
    stroke-dasharray 180ms ease,
    stroke 180ms ease;
}

.chat-main__context-arc--good {
  stroke: var(--color-success);
}

.chat-main__context-arc--warn {
  stroke: var(--color-warning);
}

.chat-main__context-arc--danger {
  stroke: var(--color-error);
}

.chat-main__config-button {
  min-width: 0;
  max-width: min(16rem, 38vw);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chat-main__empty {
  min-height: 0;
  padding: 1rem calc(var(--safe-area-right) + 1rem) 1rem 1rem;
  display: grid;
  align-content: center;
  gap: 0.45rem;
}

.chat-main__transcript {
  min-height: 0;
  min-width: 0;
  overflow: auto;
  padding: 0.6rem calc(var(--safe-area-right) + 0.7rem) 0.1rem 0.7rem;
  scroll-padding-right: calc(var(--safe-area-right) + 0.7rem);
  scroll-padding-bottom: 0.6rem;
  border: 0;
  border-radius: 0;
  box-shadow: none;
  backdrop-filter: none;
  background: var(--color-bg-panel-soft);
}

.chat-main__transcript-item {
  min-width: 0;
  padding-bottom: 0.5rem;
}

@keyframes chat-main-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 900px) {
  .chat-view {
    grid-template-columns: 1fr;
  }

  .chat-main__header {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 0.35rem 0.45rem;
    align-items: center;
    padding: calc(var(--safe-area-top) + 0.38rem) calc(var(--safe-area-right) + 0.45rem) 0.38rem
      calc(var(--safe-area-left) + 0.45rem);
  }

  .chat-main__heading {
    min-width: 0;
    grid-column: 2;
    grid-row: 1 / span 2;
    gap: 0.02rem;
  }

  .chat-main__header h2 {
    font-size: 0.96rem;
  }

  .chat-main__heading p {
    white-space: nowrap;
    word-break: normal;
    font-size: 0.84rem;
  }

  .chat-main__menu {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    grid-column: 1;
    grid-row: 1 / span 2;
    width: 2.5rem;
    height: 2.5rem;
    padding: 0;
  }

  .chat-main__toolbar {
    grid-column: 3;
    grid-row: 1 / span 2;
    width: auto;
    display: grid;
    grid-template-columns: auto auto minmax(0, 9.5rem);
    align-items: center;
    justify-content: end;
    gap: 0.22rem;
  }

  .chat-main__toolbar > * {
    min-width: 0;
  }

  .chat-main__empty {
    padding: 1rem calc(var(--safe-area-right) + 1rem) calc(var(--safe-area-bottom) + 1rem)
      calc(var(--safe-area-left) + 1rem);
  }

  .chat-main__transcript {
    padding: 0.6rem calc(var(--safe-area-right) + 0.7rem) 0.1rem
      calc(var(--safe-area-left) + 0.7rem);
    scroll-padding-left: calc(var(--safe-area-left) + 0.7rem);
  }

  .chat-main__status,
  .chat-main__context {
    width: 1.7rem;
    height: 1.7rem;
  }

  .chat-main__config-button {
    max-width: 9.5rem;
    width: 9.5rem;
    padding-inline: 0.42rem;
    font-size: 0.84rem;
  }
}
</style>
