<script setup lang="ts">
import { computed, ref } from "vue";
import { RpcError } from "@/shared/rpc";

const props = defineProps<{
  enabled: boolean;
  send: (text: string, clientMessageId: string) => Promise<{ ok: true }>;
}>();

const draft = ref("");
const pending = ref(false);
const errorMessage = ref("");
const canSend = computed(() => props.enabled && !pending.value && !!draft.value.trim());
let lastAttempt: { text: string; id: string } | undefined;
const rejectedReplyCodes = new Set(["FORBIDDEN", "NOT_FOUND", "CONFLICT", "UNAUTHORIZED"]);

async function submit(): Promise<void> {
  if (!canSend.value) return;
  const text = draft.value.trim();
  const id = lastAttempt?.text === text ? lastAttempt.id : crypto.randomUUID();
  lastAttempt = { text, id };
  errorMessage.value = "";
  pending.value = true;
  try {
    await props.send(text, id);
    draft.value = "";
    lastAttempt = undefined;
  } catch (error) {
    if (error instanceof RpcError && rejectedReplyCodes.has(error.code)) lastAttempt = undefined;
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    pending.value = false;
  }
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || event.isComposing) return;
  event.preventDefault();
  if (!event.repeat) void submit();
}
</script>

<template>
  <form class="session-reply" @submit.prevent="submit">
    <textarea
      v-model="draft"
      aria-label="Reply"
      placeholder="Reply…"
      rows="2"
      :readonly="pending"
      @keydown="handleKeydown"
    />
    <button
      type="submit"
      class="chrome-button"
      :disabled="!canSend"
      aria-keyshortcuts="Control+Enter Meta+Enter"
      title="Send reply (Ctrl/⌘+Enter)"
    >
      {{ pending ? "Sending…" : "Send" }}
    </button>
    <p v-if="errorMessage" class="session-reply__error" role="alert">{{ errorMessage }}</p>
  </form>
</template>

<style scoped>
.session-reply {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end;
  gap: 0.5rem;
  padding: 0.65rem 1rem;
  border-top: 1px solid var(--color-chrome-border);
  background: var(--color-bg-instance);
}

.session-reply textarea {
  box-sizing: border-box;
  min-height: 2.75rem;
  resize: none;
  padding: 0.45rem 0.6rem;
  border: 1px solid var(--color-chrome-border);
  border-radius: 0.55rem;
  color: inherit;
  background: var(--color-bg-panel);
  font: inherit;
  font-size: max(16px, 1rem);
}

.session-reply button {
  min-height: 2.75rem;
  min-width: 2.75rem;
}

.session-reply__error {
  grid-column: 1 / -1;
  margin: 0;
  color: var(--color-error);
  font-size: 0.85rem;
  overflow-wrap: anywhere;
}
</style>
