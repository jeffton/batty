<script setup lang="ts">
import { CircleAlert, LoaderCircle, X } from "@lucide/vue";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import SessionHeaderStatus from "@/client/components/SessionHeaderStatus.vue";
import SessionTranscriptView from "@/client/components/SessionTranscriptView.vue";
import StreamingStopControl from "@/client/components/StreamingStopControl.vue";
import { abortSession, getSessionMessages, openSession } from "@/client/lib/api";
import { applyServerEvent } from "@/client/lib/session-events";
import { mergeSessionState, normalizeSessionState } from "@/client/lib/session-state";
import { sessionEventsPath } from "@/client/lib/session-stream";
import { RECENT_SESSION_MESSAGE_WINDOW } from "@/shared/session-history";
import type { ServerEvent, SessionState } from "@/shared/types";

const props = withDefaults(
  defineProps<{
    popoverId: string;
    workspaceId: string;
    sessionPath: string;
    headerTitle?: string;
  }>(),
  {
    headerTitle: "Subagent",
  },
);

const popoverElement = ref<HTMLElement | null>(null);
const session = ref<SessionState | undefined>(undefined);
const loading = ref(false);
const loadingOlderMessages = ref(false);
const errorMessage = ref<string | undefined>(undefined);
const reconnecting = ref(false);
const stopping = ref(false);
let eventSource: EventSource | undefined;
let loadGeneration = 0;

const connectionState = computed<"online" | "connecting" | "offline">(() => {
  if (errorMessage.value && !session.value) {
    return "offline";
  }
  return reconnecting.value || !session.value ? "connecting" : "online";
});

function closeStream(): void {
  if (!eventSource) {
    return;
  }

  eventSource.onopen = null;
  eventSource.onmessage = null;
  eventSource.onerror = null;
  eventSource.close();
  eventSource = undefined;
}

function applyEvent(event: ServerEvent): void {
  const nextSession = applyServerEvent(session.value, event);
  if (!nextSession) {
    return;
  }

  session.value = nextSession;
}

function openStream(): void {
  if (!session.value) {
    return;
  }

  closeStream();
  reconnecting.value = true;
  const source = new EventSource(sessionEventsPath(session.value, "full"));
  eventSource = source;
  source.onopen = () => {
    if (eventSource !== source) {
      return;
    }

    reconnecting.value = false;
  };
  source.onmessage = (message) => {
    if (eventSource !== source) {
      return;
    }

    reconnecting.value = false;
    applyEvent(JSON.parse(message.data) as ServerEvent);
  };
  source.onerror = () => {
    if (eventSource !== source) {
      return;
    }

    reconnecting.value = true;
  };
}

async function ensureSessionLoaded(): Promise<void> {
  if (loading.value) {
    return;
  }

  const generation = ++loadGeneration;
  const workspaceId = props.workspaceId;
  const sessionPath = props.sessionPath;
  loading.value = true;
  errorMessage.value = undefined;
  try {
    const opened = normalizeSessionState(await openSession(workspaceId, sessionPath, "full"));
    if (!opened) {
      throw new Error("Failed to open session");
    }
    if (generation !== loadGeneration) {
      return;
    }
    session.value = mergeSessionState(opened, session.value);
    openStream();
  } catch (error) {
    if (generation === loadGeneration) {
      errorMessage.value = error instanceof Error ? error.message : String(error);
    }
  } finally {
    if (generation === loadGeneration) {
      loading.value = false;
    }
  }
}

async function stopSubagent(): Promise<void> {
  const current = session.value;
  if (!current?.isStreaming || stopping.value) {
    return;
  }

  stopping.value = true;
  errorMessage.value = undefined;
  try {
    await abortSession(current.id);
  } catch (error) {
    stopping.value = false;
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
}

async function loadOlderMessages(): Promise<void> {
  const current = session.value;
  if (
    !current ||
    loadingOlderMessages.value ||
    !current.hasMoreMessages ||
    current.messages.length === 0
  ) {
    return;
  }

  loadingOlderMessages.value = true;
  try {
    const before = current.messages[0]?.id;
    const page = await getSessionMessages(current, {
      ...(before ? { before } : {}),
      limit: RECENT_SESSION_MESSAGE_WINDOW,
    });
    const latest = session.value;
    if (!latest || latest.sessionId !== current.sessionId) {
      return;
    }
    if (latest.messages[0]?.id !== current.messages[0]?.id) {
      return;
    }
    const existingIds = new Set(latest.messages.map((message) => message.id));
    const olderMessages = page.messages.filter((message) => !existingIds.has(message.id));
    const paginationMetadataChanged =
      latest.totalMessageCount !== current.totalMessageCount ||
      latest.hasMoreMessages !== current.hasMoreMessages;
    session.value = normalizeSessionState({
      ...latest,
      messages: [...olderMessages, ...latest.messages],
      totalMessageCount: paginationMetadataChanged
        ? Math.max(latest.totalMessageCount, page.totalMessageCount)
        : page.totalMessageCount,
      hasMoreMessages: paginationMetadataChanged ? latest.hasMoreMessages : page.hasMoreMessages,
    });
  } finally {
    loadingOlderMessages.value = false;
  }
}

function handlePopoverToggle(event: Event): void {
  const nextState = (event as Event & { newState?: "open" | "closed" }).newState;
  if (nextState === "open") {
    void ensureSessionLoaded();
    return;
  }

  loadGeneration += 1;
  closeStream();
  loading.value = false;
  reconnecting.value = false;
}

watch(
  () => [props.workspaceId, props.sessionPath] as const,
  () => {
    loadGeneration += 1;
    closeStream();
    session.value = undefined;
    loading.value = false;
    loadingOlderMessages.value = false;
    errorMessage.value = undefined;
    reconnecting.value = false;
    stopping.value = false;
    if (popoverElement.value?.matches(":popover-open")) {
      void ensureSessionLoaded();
    }
  },
);

watch(
  () => session.value?.isStreaming,
  (isStreaming) => {
    if (isStreaming === false) {
      reconnecting.value = false;
      stopping.value = false;
    }
  },
);

onBeforeUnmount(() => {
  loadGeneration += 1;
  closeStream();
});
</script>

<template>
  <div
    :id="props.popoverId"
    ref="popoverElement"
    class="subagent-session-popover"
    popover="auto"
    @toggle="handlePopoverToggle"
  >
    <div class="subagent-session-popover__header">
      <div class="subagent-session-popover__title">{{ props.headerTitle }}</div>
      <div class="subagent-session-popover__header-actions">
        <span
          v-if="errorMessage && session"
          class="subagent-session-popover__header-error"
          role="alert"
          :aria-label="errorMessage"
          :title="errorMessage"
        >
          <CircleAlert :size="17" />
        </span>
        <StreamingStopControl
          v-if="session?.isStreaming"
          :disabled="stopping"
          label="Stop subagent"
          @stop="stopSubagent"
        />
        <SessionHeaderStatus
          :context-tokens="session?.contextTokens"
          :context-window="session?.contextWindow"
          :context-percent="session?.contextPercent"
          :connection-state="connectionState"
        />
        <button
          class="subagent-session-popover__close"
          type="button"
          aria-label="Close subagent transcript"
          title="Close"
          @click="popoverElement?.hidePopover?.()"
        >
          <X :size="16" />
        </button>
      </div>
    </div>

    <div v-if="loading && !session" class="subagent-session-popover__empty">
      <LoaderCircle :size="18" class="subagent-session-popover__spinner" />
      <span>Loading session…</span>
    </div>

    <div
      v-else-if="errorMessage && !session"
      class="subagent-session-popover__empty subagent-session-popover__empty--error"
    >
      <CircleAlert :size="18" />
      <span>{{ errorMessage }}</span>
    </div>

    <SessionTranscriptView
      v-else-if="session"
      class="subagent-session-popover__transcript"
      :session="session"
      :load-older-messages="loadOlderMessages"
      :loading-older-messages="loadingOlderMessages"
      always-show-details
      :allow-session-popovers="false"
    />
  </div>
</template>

<style scoped>
.subagent-session-popover {
  inset: calc(var(--safe-area-top) + 1rem) calc(var(--safe-area-right) + 1rem)
    calc(var(--safe-area-bottom) + 1rem) calc(var(--safe-area-left) + 1rem);
  width: auto;
  max-width: none;
  height: auto;
  max-height: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--color-border-soft);
  border-radius: 0.9rem;
  background: var(--color-bg-panel);
  color: var(--color-text);
  box-shadow: var(--color-shadow-popover);
  overflow: hidden;
  overscroll-behavior: contain;
}

.subagent-session-popover:popover-open {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
}

.subagent-session-popover::backdrop {
  background: rgb(0 0 0 / 0.22);
}

.subagent-session-popover__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.9rem 1rem 0.75rem;
  background: var(--color-bg-panel-strong);
  border-bottom: 1px solid var(--color-border-soft);
}

.subagent-session-popover__title {
  font-size: 1rem;
  font-weight: 700;
  color: var(--color-text-strong);
}

.subagent-session-popover__header-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.35rem;
  flex-shrink: 0;
}

.subagent-session-popover__header-error {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.6rem;
  height: 1.6rem;
  color: var(--color-error);
}

.subagent-session-popover__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  padding: 0;
  border: 1px solid var(--color-border-soft);
  border-radius: 0.5rem;
  background: var(--color-bg-panel);
  color: var(--color-text);
  cursor: pointer;
}

@media (hover: hover) {
  .subagent-session-popover__close:hover {
    background: var(--color-bg-elevated-soft);
  }
}

.subagent-session-popover__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.55rem;
  padding: 1.25rem;
  color: var(--color-text-subtle);
}

.subagent-session-popover__empty--error {
  color: var(--color-error);
}

.subagent-session-popover__transcript {
  min-height: 0;
}

.subagent-session-popover__transcript :deep(.transcript) {
  padding-left: 1rem;
  padding-right: 1rem;
}

.subagent-session-popover__spinner {
  animation: subagent-session-popover-spin 0.9s linear infinite;
}

@keyframes subagent-session-popover-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
