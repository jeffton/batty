<script setup lang="ts">
import { computed, ref, watch } from "vue";
import ChatHeader from "@/client/components/ChatHeader.vue";
import MessageComposer from "@/client/components/MessageComposer.vue";
import SessionTranscriptView from "@/client/components/SessionTranscriptView.vue";
import { getMain, listRunningSubagents, listWorkspaceCronRunLogs } from "@/client/lib/api";
import { applySessionResponse } from "@/client/lib/session-events";
import { promptSubmissionId, retainPromptRetry, clearPromptRetry } from "@/client/lib/prompt-retry";
import { useAppStore } from "@/client/stores/app";
import {
  optimisticTranscriptMessages,
  reconcileOptimisticMessages,
  type OptimisticUserMessage,
  type PendingOptimisticMessage,
} from "@/client/lib/optimistic-messages";
import type { CronRunLog, QueuedPrompt, RunningSubagent } from "@/shared/types";

type ComposerHandle = InstanceType<typeof MessageComposer>;

const store = useAppStore();
const composer = ref<ComposerHandle | null>(null);
const promptError = ref<string>();
const subagents = ref<RunningSubagent[]>([]);
const cronRuns = ref<CronRunLog[]>([]);
const subagentError = ref<string>();
const pendingIdlePromptSessionIds = new Set<string>();
let promptRequestId = 0;
let optimisticMessageId = 0;
// In-flight submissions belong to this page only: interrupted uploads cannot
// be resumed from filenames. Accepted queue entries are rendered from SSE.
localStorage.removeItem("batty:optimistic-messages");
const optimisticMessagesBySessionId = ref<Record<string, PendingOptimisticMessage[]>>({});
const activeOptimisticMessages = computed(() => {
  const session = store.activeSession;
  return session
    ? optimisticTranscriptMessages(
        optimisticMessagesBySessionId.value[session.sessionId] ?? [],
        session,
      )
    : [];
});
const isUnavailable = computed(() => store.connectionState !== "online");

watch(
  [() => store.activeSession?.sessionId, isUnavailable],
  ([sessionId, offline], _previous, onCleanup) => {
    subagents.value = [];
    cronRuns.value = [];
    subagentError.value = undefined;
    if (!sessionId || offline) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    onCleanup(() => {
      cancelled = true;
      clearTimeout(timer);
    });

    async function refresh(): Promise<void> {
      try {
        const [agents, workspaceRuns] = await Promise.all([
          listRunningSubagents(sessionId!),
          Promise.all(store.workspaces.map((workspace) => listWorkspaceCronRunLogs(workspace.id))),
        ]);
        if (cancelled) return;
        subagents.value = agents;
        cronRuns.value = workspaceRuns.flat().filter((run) => run.status === "running");
        subagentError.value = undefined;
      } catch (error) {
        if (cancelled) return;
        if (error instanceof TypeError) {
          console.error("Failed to refresh subagent status", error);
          subagentError.value = undefined;
        } else {
          subagentError.value = error instanceof Error ? error.message : String(error);
        }
      } finally {
        if (!cancelled) timer = setTimeout(() => void refresh(), 1_500);
      }
    }

    void refresh();
  },
  { immediate: true },
);

function showPromptError(error: unknown, sessionId: string | undefined, requestId: number): void {
  if (requestId !== promptRequestId || store.activeSession?.sessionId !== sessionId) {
    return;
  }

  promptError.value = error instanceof Error ? error.message : String(error);
}

function addOptimisticMessage(
  sessionId: string,
  clientMessageId: string,
  text: string,
  files: File[],
): string {
  const existing = optimisticMessagesBySessionId.value[sessionId]?.find(
    (item) => item.clientMessageId === clientMessageId,
  );
  if (existing) return existing.message.id;
  const submittedText = text.trim();
  const submittedFileNames = files.map((file) => file.name);
  const attachmentLabel =
    submittedFileNames.length > 0 ? `Attached: ${submittedFileNames.join(", ")}` : "";
  const displayText = [submittedText, attachmentLabel].filter(Boolean).join("\n\n");
  const message: OptimisticUserMessage = {
    id: `optimistic-user-${Date.now()}-${++optimisticMessageId}`,
    role: "user",
    timestamp: Date.now(),
    clientMessageId,
    blocks: [{ type: "text", text: displayText }],
  };

  optimisticMessagesBySessionId.value = {
    ...optimisticMessagesBySessionId.value,
    [sessionId]: [
      ...(optimisticMessagesBySessionId.value[sessionId] ?? []),
      { message, clientMessageId, showInTranscript: !store.activeSession?.isStreaming },
    ],
  };
  return message.id;
}

function removeOptimisticMessage(sessionId: string, messageId: string): void {
  const remainingForSession = (optimisticMessagesBySessionId.value[sessionId] ?? []).filter(
    (pending) => pending.message.id !== messageId,
  );
  const next = { ...optimisticMessagesBySessionId.value };
  if (remainingForSession.length > 0) {
    next[sessionId] = remainingForSession;
  } else {
    delete next[sessionId];
  }
  optimisticMessagesBySessionId.value = next;
}

function reconcileOptimisticMessage(): void {
  const session = store.activeSession;
  if (!session) {
    return;
  }

  const pending = optimisticMessagesBySessionId.value[session.sessionId] ?? [];
  const remaining = reconcileOptimisticMessages(pending, session);
  if (remaining.length === pending.length) {
    return;
  }

  const next = { ...optimisticMessagesBySessionId.value };
  if (remaining.length > 0) {
    next[session.sessionId] = remaining;
  } else {
    delete next[session.sessionId];
  }
  optimisticMessagesBySessionId.value = next;
}

function wasPromptAccepted(sessionId: string, clientMessageId: string): boolean {
  const session = store.activeSession;
  return (
    session?.sessionId === sessionId &&
    [...session.messages, ...(session.queuedPrompts ?? [])].some(
      (message) => "clientMessageId" in message && message.clientMessageId === clientMessageId,
    )
  );
}

function setOptimisticDisposition(sessionId: string, optimisticId: string, started: boolean): void {
  const item = optimisticMessagesBySessionId.value[sessionId]?.find(
    (candidate) => candidate.message.id === optimisticId,
  );
  if (item) item.showInTranscript = started;
}

async function reconcileQueuedReceipt(sessionId: string, optimisticId: string): Promise<void> {
  // A tab can miss acceptance followed by remote cancellation. A queued
  // receipt lets a fresh authoritative snapshot resolve that entire lifecycle.
  if (
    !(optimisticMessagesBySessionId.value[sessionId] ?? []).some(
      (item) => item.message.id === optimisticId,
    )
  )
    return;
  const requestedStreamId = store.activeSession?.streamId;
  try {
    const snapshot = await getMain();
    if (store.activeSession?.sessionId !== sessionId) return;
    const previous = store.activeSession;
    const updated = applySessionResponse(previous, snapshot, requestedStreamId);
    if (updated === previous) return;
    store.activeSession = updated;
    const item = (optimisticMessagesBySessionId.value[sessionId] ?? []).find(
      (candidate) => candidate.message.id === optimisticId,
    );
    if (item && !wasPromptAccepted(sessionId, item.clientMessageId)) {
      removeOptimisticMessage(sessionId, optimisticId);
    }
  } catch (error) {
    // Submission succeeded; snapshot failure must not restore its draft.
    promptError.value = error instanceof Error ? error.message : String(error);
  }
}

async function submitPrompt(mode: "prompt" | "steer", text: string, files: File[]): Promise<void> {
  const sessionId = store.activeSession?.sessionId;
  const gateSessionId = store.activeSession?.isStreaming
    ? undefined
    : store.activeSession?.sessionId;
  if (gateSessionId && pendingIdlePromptSessionIds.has(gateSessionId)) {
    return;
  }

  const requestId = ++promptRequestId;
  promptError.value = undefined;
  const clientMessageId = promptSubmissionId(sessionId!, mode, text, files);
  composer.value?.clear();
  const optimisticId =
    sessionId && !text.trimStart().startsWith("/")
      ? addOptimisticMessage(sessionId, clientMessageId, text, files)
      : undefined;
  if (gateSessionId) {
    pendingIdlePromptSessionIds.add(gateSessionId);
  }
  try {
    const receipt = await store.submitPrompt(mode, text, files, clientMessageId);
    // A started receipt can precede SSE publishing the transcript message.
    if (sessionId && optimisticId) {
      setOptimisticDisposition(sessionId, optimisticId, receipt.disposition === "started");
    }
    clearPromptRetry(sessionId!, clientMessageId);
    if (receipt.disposition === "queued" && sessionId && optimisticId) {
      await reconcileQueuedReceipt(sessionId, optimisticId);
    }
  } catch (error) {
    if (sessionId && wasPromptAccepted(sessionId, clientMessageId)) {
      clearPromptRetry(sessionId, clientMessageId);
      return;
    }
    if (sessionId) {
      if (optimisticId) {
        removeOptimisticMessage(sessionId, optimisticId);
      }
      retainPromptRetry(sessionId, mode, text, files, clientMessageId);
      composer.value?.restore(sessionId, text, files);
    }
    showPromptError(error, sessionId, requestId);
    throw error;
  } finally {
    if (gateSessionId) {
      pendingIdlePromptSessionIds.delete(gateSessionId);
    }
  }
}

watch(
  [() => store.activeSession?.messages, () => store.activeSession?.queuedPrompts],
  reconcileOptimisticMessage,
  { immediate: true, flush: "sync" },
);
watch(
  () => store.activeSession?.sessionId,
  () => {
    promptRequestId += 1;
    promptError.value = undefined;
  },
);

async function runAction(action: () => Promise<unknown>): Promise<void> {
  promptError.value = undefined;
  try {
    await action();
  } catch (error) {
    promptError.value = error instanceof Error ? error.message : String(error);
  }
}

async function removeQueuedPrompt(prompt: QueuedPrompt): Promise<void> {
  await runAction(() => store.removeQueuedPrompt(prompt.kind, prompt.index));
}
</script>

<template>
  <main class="chat-session-pane">
    <ChatHeader />

    <div v-if="!store.activeSession" class="chat-loading">
      <p v-if="store.lastError" role="alert">{{ store.lastError }}</p>
      <template v-else
        ><div class="spinner" />
        <p class="muted">Loading chat…</p></template
      >
    </div>
    <template v-else>
      <SessionTranscriptView
        :session="store.activeSession"
        :optimistic-messages="activeOptimisticMessages"
        :load-older-messages="() => store.loadOlderMessages()"
        :loading-older-messages="store.loadingOlderMessages"
      />

      <MessageComposer
        ref="composer"
        :streaming="store.activeSession.isStreaming"
        :compacting="store.activeSession.isCompacting"
        :memory-pending="store.activeSession.memoryPreparation?.pending"
        :subagents="subagents"
        :cron-runs="cronRuns"
        :session-key="store.activeSession.sessionId"
        :offline="isUnavailable"
        :error="
          promptError ??
          store.activeSession.memoryPreparation?.error ??
          subagentError ??
          store.lastError
        "
        :actions-disabled="isUnavailable"
        :queued-prompts="store.activeSession.queuedPrompts"
        @submit="(text, files) => submitPrompt('prompt', text, files)"
        @steer="(text, files) => submitPrompt('steer', text, files)"
        @stop="runAction(() => store.stopActiveSession())"
        @remove-queued-prompt="removeQueuedPrompt"
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
