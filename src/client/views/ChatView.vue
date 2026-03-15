<script setup lang="ts">
import { LoaderCircle, Wifi, WifiOff } from "lucide-vue-next";
import { computed, nextTick, ref, watch } from "vue";
import ChatMessage from "@/client/components/ChatMessage.vue";
import MessageComposer from "@/client/components/MessageComposer.vue";
import SessionSidebar from "@/client/components/SessionSidebar.vue";
import { withoutRenderedToolCalls } from "@/client/lib/active-assistant";
import { formatTokenCount } from "@/client/lib/formatting";
import { resolveThinkingOptions } from "@/client/lib/thinking-levels";
import {
  buildToolStateLookup,
  buildTranscriptMessages,
  toolStatesForMessage,
} from "@/client/lib/transcript";
import type { ModelOption } from "@/shared/types";
import { useAppStore } from "@/client/stores/app";

const MODEL_POPOVER_ID = "chat-main-model-popover";

const store = useAppStore();
const transcript = ref<HTMLElement>();
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
const modelGroups = computed(() => {
  const groups = new Map<string, ModelOption[]>();

  for (const model of store.models) {
    const existing = groups.get(model.provider) ?? [];
    existing.push(model);
    groups.set(model.provider, existing);
  }

  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([provider, models]) => ({
      provider,
      models: [...models].sort((left, right) =>
        shortModelLabel(left).localeCompare(shortModelLabel(right)),
      ),
    }));
});

function shortModelLabel(model: Pick<ModelOption, "label">): string {
  return model.label.split(" · ", 1)[0] ?? model.label;
}

function thinkingLabel(value: string): string {
  return value === "xhigh" ? "XHigh" : value.charAt(0).toUpperCase() + value.slice(1);
}

function updateTranscriptPinnedState(): void {
  const element = transcript.value;
  if (!element) {
    isTranscriptPinnedToBottom.value = true;
    return;
  }

  const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
  isTranscriptPinnedToBottom.value = distanceFromBottom <= 24;
}

async function scrollToBottom(behavior: ScrollBehavior = "auto"): Promise<void> {
  await nextTick();
  transcript.value?.scrollTo({ top: transcript.value.scrollHeight, behavior });
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

watch(
  () => store.activeSession,
  (current, previous) => {
    const openedSession = current?.id !== previous?.id;
    if (openedSession) {
      isTranscriptPinnedToBottom.value = true;
      void scrollToBottom("auto");
      return;
    }

    if (!isTranscriptPinnedToBottom.value) {
      return;
    }

    void scrollToBottom(current?.isStreaming ? "auto" : "smooth");
  },
  { deep: true },
);
</script>

<template>
  <main class="chat-view">
    <SessionSidebar />
    <section class="chat-main">
      <header class="chat-main__header panel">
        <button class="chat-main__menu" @click="store.mobileSidebarOpen = true">☰</button>
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
            :disabled="!store.activeSession"
            :popovertarget="MODEL_POPOVER_ID"
          >
            {{ modelThinkingButtonLabel }}
          </button>
          <div :id="MODEL_POPOVER_ID" class="chat-main__popover" popover>
            <section class="chat-main__popover-section">
              <div class="chat-main__popover-title">Model</div>
              <details
                v-for="group in modelGroups"
                :key="group.provider"
                class="chat-main__provider-group"
                :open="group.models.some((model) => model.id === store.activeSession?.model)"
              >
                <summary class="chat-main__provider-summary">{{ group.provider }}</summary>
                <div class="chat-main__provider-models">
                  <button
                    v-for="model in group.models"
                    :key="model.id"
                    type="button"
                    :class="[
                      'chat-main__popover-option',
                      model.id === store.activeSession?.model ? 'is-active' : '',
                    ]"
                    @click="setModel(model.id)"
                  >
                    {{ shortModelLabel(model) }}
                  </button>
                </div>
              </details>
            </section>
            <section class="chat-main__popover-section">
              <div class="chat-main__popover-title">Thinking</div>
              <div class="chat-main__thinking-options">
                <button
                  v-for="option in thinkingOptions"
                  :key="option"
                  type="button"
                  :class="[
                    'chat-main__popover-option',
                    option === store.activeSession?.thinkingLevel ? 'is-active' : '',
                  ]"
                  @click="setThinkingLevel(option)"
                >
                  {{ thinkingLabel(option) }}
                </button>
              </div>
            </section>
            <button class="chat-main__popover-close" type="button" @click="closeModelPopover">
              Done
            </button>
          </div>
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
        <section
          ref="transcript"
          class="chat-main__transcript panel"
          @scroll="updateTranscriptPinnedState"
        >
          <ChatMessage
            v-for="entry in transcriptMessages"
            :key="entry.message.id"
            :message="entry.message"
            :tool-states-by-call-id="entry.toolStatesByCallId"
          />
          <ChatMessage
            v-if="activeAssistantMessage"
            :message="activeAssistantMessage"
            :tool-states-by-call-id="activeAssistantToolStates"
          />
        </section>

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
  gap: 0.55rem;
  padding: 0.55rem;
  overflow: hidden;
}

.chat-main {
  min-width: 0;
  min-height: 0;
  display: grid;
  gap: 0.55rem;
  grid-template-rows: auto minmax(0, 1fr) auto;
  overflow: hidden;
}

.chat-main__header {
  min-width: 0;
  padding: 0.5rem 0.65rem;
  display: flex;
  gap: 0.55rem;
  align-items: center;
  justify-content: space-between;
  border: 0;
  border-radius: 0;
  box-shadow: none;
  backdrop-filter: none;
  background: rgba(26, 31, 40, 0.98);
}

.chat-main__heading {
  min-width: 0;
  display: grid;
  gap: 0.05rem;
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
  gap: 0.32rem;
  flex-wrap: wrap;
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
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(22, 27, 34, 0.95);
  color: inherit;
  padding: 0.36rem 0.5rem;
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
  border: 1px solid rgba(255, 255, 255, 0.07);
  background: rgba(22, 27, 34, 0.75);
  color: #c5ced8;
  flex: 0 0 auto;
}

.chat-main__status-icon--online {
  color: #22c55e;
}

.chat-main__status-icon--connecting {
  color: #d1d5db;
}

.chat-main__status-icon--offline {
  color: #f59e0b;
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
  stroke: rgba(255, 255, 255, 0.12);
}

.chat-main__context-arc {
  stroke-linecap: round;
  transition:
    stroke-dasharray 180ms ease,
    stroke 180ms ease;
}

.chat-main__context-arc--good {
  stroke: #22c55e;
}

.chat-main__context-arc--warn {
  stroke: #f59e0b;
}

.chat-main__context-arc--danger {
  stroke: #ef4444;
}

.chat-main__config-button {
  min-width: 0;
  max-width: min(18rem, 42vw);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chat-main__popover {
  width: min(28rem, calc(100vw - 2rem));
  margin: 0;
  padding: 0.7rem;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 0.65rem;
  background: rgba(22, 27, 34, 0.98);
  color: inherit;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.38);
}

.chat-main__popover::backdrop {
  background: rgba(0, 0, 0, 0.18);
}

.chat-main__popover-section {
  display: grid;
  gap: 0.45rem;
}

.chat-main__popover-section + .chat-main__popover-section {
  margin-top: 0.75rem;
}

.chat-main__popover-title {
  font-size: 0.76rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #93a0ad;
}

.chat-main__provider-group {
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 0.45rem;
  background: rgba(255, 255, 255, 0.03);
}

.chat-main__provider-summary {
  cursor: pointer;
  list-style: none;
  padding: 0.5rem 0.6rem;
  font-weight: 600;
  text-transform: capitalize;
}

.chat-main__provider-summary::-webkit-details-marker {
  display: none;
}

.chat-main__provider-models,
.chat-main__thinking-options {
  display: grid;
  gap: 0.3rem;
  padding: 0 0.4rem 0.4rem;
}

.chat-main__popover-option {
  width: 100%;
  text-align: left;
  border-radius: 0.4rem;
  border: 1px solid rgba(255, 255, 255, 0.06);
  background: rgba(255, 255, 255, 0.04);
  color: inherit;
  padding: 0.42rem 0.55rem;
}

.chat-main__popover-option.is-active {
  border-color: rgba(96, 165, 250, 0.45);
  background: rgba(37, 99, 235, 0.18);
  color: #dbeafe;
}

.chat-main__popover-close {
  margin-top: 0.8rem;
  width: 100%;
  border-radius: 0.45rem;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.06);
  color: inherit;
  padding: 0.45rem 0.6rem;
}

.chat-main__empty {
  min-height: 0;
  padding: 1rem;
  display: grid;
  align-content: center;
  gap: 0.45rem;
}

.chat-main__transcript {
  min-height: 0;
  overflow: auto;
  padding: 0.6rem 0.7rem;
  display: grid;
  gap: 0.5rem;
  align-content: start;
  scroll-padding-bottom: 0.6rem;
  border: 0;
  border-radius: 0;
  box-shadow: none;
  backdrop-filter: none;
  background: rgba(16, 20, 27, 0.98);
}

@keyframes chat-main-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 900px) {
  .chat-view {
    grid-template-columns: 1fr;
    padding: 0.45rem;
  }

  .chat-main__header {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: start;
  }

  .chat-main__heading {
    min-width: 0;
  }

  .chat-main__heading p {
    white-space: normal;
    word-break: break-word;
  }

  .chat-main__menu {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    grid-row: 1;
    grid-column: 1;
  }

  .chat-main__toolbar {
    grid-column: 1 / -1;
    width: 100%;
    display: grid;
    grid-template-columns: auto auto minmax(0, 1fr);
    justify-content: stretch;
  }

  .chat-main__toolbar > * {
    min-width: 0;
  }

  .chat-main__config-button {
    max-width: none;
    width: 100%;
  }
}
</style>
