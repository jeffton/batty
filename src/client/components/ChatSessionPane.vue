<script setup lang="ts">
import { computed, ref } from "vue";
import ChatHeader from "@/client/components/ChatHeader.vue";
import MessageComposer from "@/client/components/MessageComposer.vue";
import SessionTranscriptView from "@/client/components/SessionTranscriptView.vue";
import { formatTokenCount } from "@/client/lib/formatting";
import { resolveThinkingOptions } from "@/client/lib/thinking-levels";
import { useAppStore } from "@/client/stores/app";
import type { QueuedPrompt } from "@/shared/types";

const MODEL_POPOVER_ID = "chat-main-model-popover";
const MODEL_POPOVER_ANCHOR = "--chat-main-model-anchor";
const CRON_POPOVER_ID = "chat-main-cron-popover";
const CRON_POPOVER_ANCHOR = "--chat-main-cron-anchor";

type ComposerHandle = InstanceType<typeof MessageComposer> & {
  clear: () => void;
  restore: (text: string, files: File[]) => void;
};

const emit = defineEmits<{
  back: [];
}>();

const store = useAppStore();
const composer = ref<ComposerHandle | null>(null);
const thinkingOptions = computed(() => resolveThinkingOptions(store.activeSession));
const pendingIdlePromptSessionIds = new Set<string>();
const isUnavailable = computed(() => store.connectionState === "offline");
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

function refreshModels(): void {
  void store.refreshModels();
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
  const gateSessionId = store.activeSession?.isStreaming
    ? undefined
    : store.activeSession?.sessionId;
  if (gateSessionId && pendingIdlePromptSessionIds.has(gateSessionId)) {
    return;
  }

  composer.value?.clear();
  if (gateSessionId) {
    pendingIdlePromptSessionIds.add(gateSessionId);
  }
  try {
    await store.sendPrompt(text, files);
  } catch (error) {
    if (shouldRestoreComposerAfterPromptError(before)) {
      composer.value?.restore(text, files);
    }
    throw error;
  } finally {
    if (gateSessionId) {
      pendingIdlePromptSessionIds.delete(gateSessionId);
    }
  }
}

async function removeQueuedPrompt(prompt: QueuedPrompt): Promise<void> {
  await store.removeQueuedPrompt(prompt.kind, prompt.index);
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
  const gateSessionId = store.activeSession?.isStreaming
    ? undefined
    : store.activeSession?.sessionId;
  if (gateSessionId && pendingIdlePromptSessionIds.has(gateSessionId)) {
    return;
  }

  composer.value?.clear();
  if (gateSessionId) {
    pendingIdlePromptSessionIds.add(gateSessionId);
  }
  try {
    await store.steerPrompt(text, files);
  } catch (error) {
    if (shouldRestoreComposerAfterPromptError(before)) {
      composer.value?.restore(text, files);
    }
    throw error;
  } finally {
    if (gateSessionId) {
      pendingIdlePromptSessionIds.delete(gateSessionId);
    }
  }
}
</script>

<template>
  <main class="chat-session-pane">
    <ChatHeader
      :cron-popover-id="CRON_POPOVER_ID"
      :cron-popover-anchor="CRON_POPOVER_ANCHOR"
      :workspace-label="store.selectedWorkspace?.label"
      :cwd="store.activeSession?.cwd"
      :workspace-switcher-loading="workspaceSwitcherLoading"
      :selected-workspace-id="store.selectedWorkspaceId"
      :context-usage-label="contextUsageLabel"
      :context-arc-class="contextArcClass"
      :context-arc-style="contextArcStyle"
      :connection-state="store.connectionState"
      :connection-description="connectionDescription"
      @back="emit('back')"
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
      <SessionTranscriptView
        :session="store.activeSession"
        :load-older-messages="() => store.loadOlderMessages()"
        :loading-older-messages="store.loadingOlderMessages"
      />

      <MessageComposer
        ref="composer"
        :streaming="store.activeSession.isStreaming"
        :session-key="store.activeSession.sessionId"
        :offline="isUnavailable"
        :actions-disabled="isUnavailable"
        :queued-prompts="store.activeSession.queuedPrompts"
        :model-popover-id="MODEL_POPOVER_ID"
        :model-popover-anchor="MODEL_POPOVER_ANCHOR"
        :models="store.models"
        :current-model-id="store.activeSession?.model"
        :current-thinking-level="store.activeSession?.thinkingLevel ?? 'off'"
        :thinking-options="thinkingOptions"
        :model-button-label="modelButtonLabel"
        :thinking-button-label="thinkingButtonLabel"
        @submit="sendPrompt"
        @steer="steerPrompt"
        @stop="store.stopActiveSession"
        @remove-queued-prompt="removeQueuedPrompt"
        @refresh-models="refreshModels"
        @set-model="setModel"
        @set-thinking-level="setThinkingLevel"
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
