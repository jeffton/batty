<script setup lang="ts">
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
import { useAppStore } from "@/client/stores/app";

const store = useAppStore();
const transcript = ref<HTMLElement>();
const isTranscriptPinnedToBottom = ref(true);
const modelId = computed({
  get: () => store.activeSession?.model ?? "",
  set: (value: string) => {
    if (value) {
      void store.setModel(value);
    }
  },
});
const thinkingLevel = computed({
  get: () => store.activeSession?.thinkingLevel ?? "",
  set: (value: string) => {
    if (value) {
      void store.setThinkingLevel(value);
    }
  },
});
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
const connectionLabel = computed(() => store.connectionState);
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
          <span class="chat-main__status" :aria-label="connectionDescription">
            <span
              :class="['chat-main__status-dot', `chat-main__status-dot--${store.connectionState}`]"
            />
            <span class="chat-main__status-label">{{ connectionLabel }}</span>
          </span>
          <div
            class="chat-main__context"
            :aria-label="contextUsageLabel"
            :title="contextUsageLabel"
          >
            <svg class="chat-main__context-chart" viewBox="0 0 36 36" aria-hidden="true">
              <path
                class="chat-main__context-track"
                d="M18 2.0845
                  a 15.9155 15.9155 0 0 1 0 31.831
                  a 15.9155 15.9155 0 0 1 0 -31.831"
              />
              <path
                :class="['chat-main__context-arc', contextArcClass]"
                :style="contextArcStyle"
                d="M18 2.0845
                  a 15.9155 15.9155 0 0 1 0 31.831
                  a 15.9155 15.9155 0 0 1 0 -31.831"
              />
            </svg>
            <span class="chat-main__context-label">{{ contextUsageLabel }}</span>
          </div>
          <select v-model="modelId" class="chat-main__select" :disabled="!store.activeSession">
            <option value="">Select model</option>
            <option v-for="model in store.models" :key="model.id" :value="model.id">
              {{ model.label }}
            </option>
          </select>
          <select
            v-model="thinkingLevel"
            class="chat-main__select"
            :disabled="!store.activeSession || thinkingOptions.length === 0"
          >
            <option value="">Thinking</option>
            <option v-for="option in thinkingOptions" :key="option" :value="option">
              {{ thinkingLabel(option) }}
            </option>
          </select>
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
  padding: 0.6rem 0.75rem;
  display: flex;
  gap: 0.65rem;
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
  gap: 0.1rem;
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
  display: flex;
  align-items: center;
  gap: 0.55rem;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.chat-main__select,
.chat-main__menu,
.chat-main__status,
.chat-main__context {
  font-size: 0.88rem;
}

.chat-main__select,
.chat-main__menu {
  border-radius: 0.45rem;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(22, 27, 34, 0.95);
  color: inherit;
  padding: 0.42rem 0.6rem;
}

.chat-main__menu {
  display: none;
}

.chat-main__status,
.chat-main__context {
  display: inline-flex;
  align-items: center;
  gap: 0.42rem;
  color: #c5ced8;
}

.chat-main__status {
  text-transform: lowercase;
}

.chat-main__status-dot {
  width: 0.62rem;
  height: 0.62rem;
  border-radius: 999px;
  flex: 0 0 auto;
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.06),
    0 0 12px currentColor;
}

.chat-main__status-dot--online {
  color: #22c55e;
  background: #22c55e;
}

.chat-main__status-dot--connecting {
  color: #a3a3a3;
  background: #a3a3a3;
}

.chat-main__status-dot--offline {
  color: #f59e0b;
  background: #f59e0b;
}

.chat-main__context {
  min-width: 0;
}

.chat-main__context-chart {
  width: 1.2rem;
  height: 1.2rem;
  flex: 0 0 auto;
  transform: rotate(-90deg);
}

.chat-main__context-track,
.chat-main__context-arc {
  fill: none;
  stroke-width: 3;
  stroke-linecap: round;
}

.chat-main__context-track {
  stroke: rgba(255, 255, 255, 0.12);
}

.chat-main__context-arc {
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

.chat-main__context-label {
  white-space: nowrap;
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
    grid-template-columns: repeat(2, minmax(0, 1fr));
    justify-content: stretch;
  }

  .chat-main__toolbar > * {
    min-width: 0;
  }

  .chat-main__select,
  .chat-main__context,
  .chat-main__status {
    width: 100%;
  }
}
</style>
