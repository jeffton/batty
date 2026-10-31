<script setup lang="ts">
import { CircleAlert, LoaderCircle } from "@lucide/vue";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import FullPopover from "@/client/components/FullPopover.vue";
import SessionHeaderStatus from "@/client/components/SessionHeaderStatus.vue";
import StreamingStopControl from "@/client/components/StreamingStopControl.vue";
import SessionTranscriptView from "@/client/components/SessionTranscriptView.vue";
import {
  HttpError,
  getSessionMessages,
  getSession,
  stopSubagent,
  stopCronRun,
} from "@/client/lib/api";
import { applyServerEvent } from "@/client/lib/session-events";
import { mergeSessionState, normalizeSessionState } from "@/client/lib/session-state";
import { sessionEventsPath, sessionHistoryCursor } from "@/client/lib/session-stream";
import { prependHistoryPage } from "@/client/lib/session-pagination";
import { createSessionConnection } from "@/client/lib/session-connection";
import { RECENT_SESSION_MESSAGE_WINDOW } from "@/shared/session-history";
import type { CronRunLog, ServerEvent, SessionState } from "@/shared/types";

const props = withDefaults(
  defineProps<{
    popoverId: string;
    sessionId: string;
    headerTitle?: string;
    cronRun?: Pick<CronRunLog, "runId" | "status">;
  }>(),
  {
    headerTitle: "Subagent",
  },
);

const session = ref<SessionState | undefined>(undefined);
const loading = ref(false);
const loadingOlderMessages = ref(false);
const stopping = ref(false);
const missing = ref(false);
const canStop = computed(
  () =>
    !missing.value &&
    (props.cronRun ? props.cronRun.status === "running" : session.value?.canStopSubagent),
);
const errorMessage = ref<string | undefined>(undefined);
const displayError = computed(() => errorMessage.value ?? session.value?.remote?.error);
const connectionState = ref<"online" | "connecting" | "offline">("connecting");
let connection: ReturnType<typeof createSessionConnection> | undefined;
let loadGeneration = 0;

function closeStream(): void {
  connection?.close();
  connection = undefined;
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
  connection = createSessionConnection({
    path: () => sessionEventsPath(session.value!, sessionHistoryCursor(session.value)),
    onConnecting: () => {
      connectionState.value = "connecting";
    },
    onError: () => {
      connectionState.value = "offline";
    },
    onEvent: (event) => {
      applyEvent(event);
      if (event.type === "reset") connectionState.value = "online";
    },
  });
  connection.open();
}

function handleSessionError(error: unknown): void {
  if (error instanceof HttpError && error.status === 404) {
    closeStream();
    session.value = undefined;
    missing.value = true;
    errorMessage.value = undefined;
  } else {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
}

async function ensureSessionLoaded(): Promise<void> {
  if (loading.value) {
    return;
  }

  const generation = ++loadGeneration;
  loading.value = true;
  connectionState.value = "connecting";
  errorMessage.value = undefined;
  missing.value = false;
  try {
    const opened = normalizeSessionState(await getSession(props.sessionId));
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
      connectionState.value = "offline";
      handleSessionError(error);
    }
  } finally {
    if (generation === loadGeneration) {
      loading.value = false;
    }
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

  const generation = loadGeneration;
  loadingOlderMessages.value = true;
  try {
    const before = current.messages[0]?.id;
    const page = await getSessionMessages(current, {
      ...(before ? { before } : {}),
      limit: RECENT_SESSION_MESSAGE_WINDOW,
    });
    const latest = session.value;
    if (generation === loadGeneration && latest)
      session.value = prependHistoryPage(latest, current, page);
  } catch (error) {
    if (generation === loadGeneration) handleSessionError(error);
  } finally {
    if (generation === loadGeneration) loadingOlderMessages.value = false;
  }
}

async function stop(): Promise<void> {
  if (!canStop.value || stopping.value || connectionState.value !== "online") return;
  const generation = loadGeneration;
  stopping.value = true;
  errorMessage.value = undefined;
  try {
    if (props.cronRun) await stopCronRun(props.cronRun.runId);
    else await stopSubagent(props.sessionId);
  } catch (error) {
    if (generation === loadGeneration) handleSessionError(error);
  } finally {
    stopping.value = false;
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
  loadingOlderMessages.value = false;
  connectionState.value = "connecting";
}

watch(
  () => props.sessionId,
  () => {
    loadGeneration += 1;
    closeStream();
    session.value = undefined;
    missing.value = false;
    loading.value = false;
    loadingOlderMessages.value = false;
    errorMessage.value = undefined;
    if (document.getElementById(props.popoverId)?.matches(":popover-open"))
      void ensureSessionLoaded();
  },
);

onBeforeUnmount(() => {
  loadGeneration += 1;
  closeStream();
});
</script>

<template>
  <FullPopover
    class="subagent-session-popover"
    :popover-id="props.popoverId"
    :title="props.headerTitle"
    close-label="Close subagent transcript"
    @toggle="handlePopoverToggle"
  >
    <template #header-actions>
      <StreamingStopControl
        v-if="canStop"
        :label="props.cronRun ? 'Stop cron run' : 'Stop subagent'"
        :disabled="stopping || connectionState !== 'online'"
        @stop="stop"
      />
      <span
        v-if="displayError && session"
        class="subagent-session-popover__header-error"
        role="alert"
        :aria-label="displayError"
        :title="displayError"
      >
        <CircleAlert :size="17" />
      </span>
      <SessionHeaderStatus
        v-if="!missing"
        :context-tokens="session?.contextTokens"
        :context-window="session?.contextWindow"
        :context-percent="session?.contextPercent"
        :connection-state="session?.remote?.error ? 'offline' : connectionState"
      />
    </template>

    <div class="subagent-session-popover__body">
      <div v-if="loading && !session" class="subagent-session-popover__empty">
        <LoaderCircle :size="18" class="subagent-session-popover__spinner" />
        <span>Loading session…</span>
      </div>

      <div v-else-if="missing" class="subagent-session-popover__empty" role="status">
        <span>This session is no longer available.</span>
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
        :allow-session-popovers="true"
      />
    </div>
  </FullPopover>
</template>

<style scoped>
.subagent-session-popover__header-error {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.6rem;
  height: 1.6rem;
  color: var(--color-error);
}

.subagent-session-popover__body {
  display: grid;
  height: 100%;
  min-height: 0;
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
