<script setup lang="ts">
import { CircleAlert, LoaderCircle, X } from "@lucide/vue";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import SessionTranscriptView from "@/client/components/SessionTranscriptView.vue";
import { getSessionMessages, openSession } from "@/client/lib/api";
import { applyServerEvent } from "@/client/lib/session-events";
import { mergeSessionState, normalizeSessionState } from "@/client/lib/session-state";
import { sessionEventsPath } from "@/client/lib/session-stream";
import { RECENT_SESSION_MESSAGE_WINDOW } from "@/shared/session-history";
import type { ServerEvent, SessionState } from "@/shared/types";

const props = withDefaults(
  defineProps<{
    popoverId: string;
    title: string;
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
let eventSource: EventSource | undefined;

const subtitle = computed(() => {
  if (!session.value) {
    return "";
  }

  return session.value.isStreaming ? "Streaming live" : "Read-only transcript";
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
  const source = new EventSource(sessionEventsPath(session.value));
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

  loading.value = true;
  errorMessage.value = undefined;
  try {
    const opened = normalizeSessionState(await openSession(props.workspaceId, props.sessionPath));
    if (!opened) {
      throw new Error("Failed to open session");
    }
    session.value = mergeSessionState(opened, session.value);
    openStream();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    loading.value = false;
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
    const existingIds = new Set(current.messages.map((message) => message.id));
    const olderMessages = page.messages.filter((message) => !existingIds.has(message.id));
    session.value = normalizeSessionState({
      ...current,
      messages: [...olderMessages, ...current.messages],
      totalMessageCount: page.totalMessageCount,
      hasMoreMessages: page.hasMoreMessages,
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

  closeStream();
  reconnecting.value = false;
}

watch(
  () => [props.workspaceId, props.sessionPath] as const,
  () => {
    closeStream();
    session.value = undefined;
    loading.value = false;
    loadingOlderMessages.value = false;
    errorMessage.value = undefined;
    reconnecting.value = false;
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
    }
  },
);

onBeforeUnmount(() => {
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
      <div>
        <div class="subagent-session-popover__title">{{ props.headerTitle }}</div>
        <div class="subagent-session-popover__subtitle">{{ props.title }}</div>
      </div>
      <button
        class="subagent-session-popover__close"
        type="button"
        @click="popoverElement?.hidePopover?.()"
      >
        <X :size="16" />
      </button>
    </div>

    <div v-if="subtitle || reconnecting" class="subagent-session-popover__status-row">
      <span v-if="subtitle" class="subagent-session-popover__status-pill">
        <LoaderCircle
          v-if="session?.isStreaming || reconnecting"
          :size="14"
          class="subagent-session-popover__spinner"
        />
        {{ reconnecting ? "Reconnecting…" : subtitle }}
      </span>
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
      always-show-tool-calls
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
  grid-template-rows: auto auto minmax(0, 1fr);
}

.subagent-session-popover::backdrop {
  background: rgb(0 0 0 / 0.22);
}

.subagent-session-popover__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.9rem 1rem 0.75rem;
  border-bottom: 1px solid var(--color-border-soft);
}

.subagent-session-popover__title {
  font-size: 1rem;
  font-weight: 700;
  color: var(--color-text-strong);
}

.subagent-session-popover__subtitle {
  margin-top: 0.2rem;
  color: var(--color-text-subtle);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.subagent-session-popover__status-row {
  display: flex;
  gap: 0.5rem;
  padding: 0.65rem 1rem 0;
}

.subagent-session-popover__status-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.25rem 0.55rem;
  border-radius: 999px;
  background: var(--color-bg-inline-code);
  color: var(--color-info);
  font-size: 0.88rem;
  font-weight: 600;
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
