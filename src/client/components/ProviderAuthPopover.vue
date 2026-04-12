<script setup lang="ts">
import { ExternalLink, KeyRound } from "lucide-vue-next";
import { computed, ref, watch } from "vue";
import { formatShortDateTime } from "@/client/lib/formatting";
import { useAppStore } from "@/client/stores/app";

const props = defineProps<{
  popoverId: string;
  anchorName: string;
}>();

const store = useAppStore();
const connectPending = ref(false);
const completePending = ref(false);
const authAttemptId = ref("");
const authUrl = ref("");
const authInstructions = ref("");
const authExpiresAt = ref<number | null>(null);
const authInput = ref("");
const authError = ref("");

const openAICodexStatus = computed(() =>
  store.providerAuth.providers.find((provider) => provider.id === "openai-codex"),
);
const hasOpenAICodexAttempt = computed(() => authAttemptId.value.length > 0);
const authExpiryLabel = computed(() =>
  authExpiresAt.value == null ? "" : formatShortDateTime(authExpiresAt.value),
);

function resetAttempt(): void {
  authAttemptId.value = "";
  authUrl.value = "";
  authInstructions.value = "";
  authExpiresAt.value = null;
  authInput.value = "";
}

function openAuthUrl(): void {
  if (!authUrl.value) {
    return;
  }
  window.open(authUrl.value, "_blank", "noopener,noreferrer");
}

async function startOpenAICodexAuth(): Promise<void> {
  connectPending.value = true;
  authError.value = "";
  try {
    const result = await store.startOpenAICodexProviderAuth();
    authAttemptId.value = result.attemptId;
    authUrl.value = result.authUrl;
    authInstructions.value = result.instructions ?? "";
    authExpiresAt.value = result.expiresAt;
    authInput.value = "";
  } catch (error) {
    authError.value = error instanceof Error ? error.message : String(error);
  } finally {
    connectPending.value = false;
  }
}

async function completeOpenAICodexAuth(): Promise<void> {
  if (!authAttemptId.value || !authInput.value.trim()) {
    return;
  }

  completePending.value = true;
  authError.value = "";
  try {
    await store.completeOpenAICodexProviderAuth(authAttemptId.value, authInput.value.trim());
    resetAttempt();
    authError.value = "";
  } catch (error) {
    authError.value = error instanceof Error ? error.message : String(error);
  } finally {
    completePending.value = false;
  }
}

watch(
  () => document.getElementById(props.popoverId)?.matches(":popover-open"),
  (open) => {
    if (!open) {
      return;
    }

    authError.value = "";
    void store.refreshProviderAuthStatus();
  },
);
</script>

<template>
  <div
    :id="props.popoverId"
    class="provider-auth-popover"
    :style="{ 'position-anchor': props.anchorName }"
    popover="auto"
  >
    <div class="provider-auth-popover__header">
      <div>
        <div class="provider-auth-popover__title">ChatGPT/Codex subscription</div>
        <div class="provider-auth-popover__subtitle">Provider: openai-codex</div>
      </div>
      <span
        :class="[
          'provider-auth-popover__badge',
          openAICodexStatus?.connected
            ? 'provider-auth-popover__badge--connected'
            : 'provider-auth-popover__badge--disconnected',
        ]"
      >
        <KeyRound v-if="openAICodexStatus?.connected" :size="13" />
        {{ openAICodexStatus?.connected ? "Connected" : "Not connected" }}
      </span>
    </div>

    <div v-if="openAICodexStatus?.connectedEmail" class="provider-auth-popover__account">
      Connected account: <strong>{{ openAICodexStatus.connectedEmail }}</strong>
    </div>

    <p class="provider-auth-popover__copy">
      Sign in with your ChatGPT/Codex subscription to use <code>openai-codex/*</code> models.
    </p>

    <button
      class="provider-auth-popover__action"
      type="button"
      :disabled="connectPending || completePending"
      @click="startOpenAICodexAuth"
    >
      {{
        connectPending
          ? "Starting…"
          : hasOpenAICodexAttempt
            ? "Restart connect flow"
            : openAICodexStatus?.connected
              ? "Reconnect account"
              : "Connect ChatGPT/Codex"
      }}
    </button>

    <div v-if="hasOpenAICodexAttempt" class="provider-auth-popover__attempt">
      <div v-if="authInstructions" class="provider-auth-popover__help">{{ authInstructions }}</div>
      <div class="provider-auth-popover__help">
        Open the sign-in page, finish login in the browser, then paste the localhost callback URL or
        just the authorization code here.
      </div>
      <div v-if="authExpiryLabel" class="provider-auth-popover__help">
        Expires: {{ authExpiryLabel }}
      </div>

      <button class="provider-auth-popover__link" type="button" @click="openAuthUrl">
        <ExternalLink :size="14" /> Open sign-in page
      </button>

      <textarea
        v-model="authInput"
        class="provider-auth-popover__input"
        rows="4"
        placeholder="Paste the localhost callback URL or the authorization code"
        :disabled="completePending"
      />

      <button
        class="provider-auth-popover__action provider-auth-popover__action--primary"
        type="button"
        :disabled="completePending || !authInput.trim()"
        @click="completeOpenAICodexAuth"
      >
        {{ completePending ? "Completing…" : "Complete connection" }}
      </button>
    </div>

    <div v-if="authError" class="provider-auth-popover__error">{{ authError }}</div>
  </div>
</template>

<style scoped>
.provider-auth-popover {
  display: none;
}

.provider-auth-popover:popover-open {
  position: fixed;
  position-area: block-end span-inline-end;
  position-try-fallbacks:
    block-end span-inline-start,
    block-start span-inline-end,
    block-start span-inline-start;
  width: min(24rem, calc(100vw - var(--safe-area-left) - var(--safe-area-right) - 1rem));
  max-width: calc(100vw - var(--safe-area-left) - var(--safe-area-right) - 1rem);
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
  margin: 0;
  padding: 0.65rem;
  border: 1px solid var(--color-border-soft);
  border-radius: 0.75rem;
  background: var(--color-bg-overlay);
  color: inherit;
  box-shadow: var(--color-shadow-popover);
}

.provider-auth-popover::backdrop {
  background: var(--color-backdrop);
}

.provider-auth-popover__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.5rem;
}

.provider-auth-popover__title {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--color-text-strong);
}

.provider-auth-popover__subtitle,
.provider-auth-popover__copy,
.provider-auth-popover__help,
.provider-auth-popover__account {
  font-size: 0.82rem;
  color: var(--color-text-subtle);
}

.provider-auth-popover__copy {
  margin: 0;
}

.provider-auth-popover__badge {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  border-radius: 999px;
  padding: 0.18rem 0.5rem;
  font-size: 0.72rem;
  font-weight: 600;
  white-space: nowrap;
}

.provider-auth-popover__badge--connected {
  background: color-mix(in srgb, var(--color-success) 18%, transparent);
  color: var(--color-success);
}

.provider-auth-popover__badge--disconnected {
  background: var(--color-bg-elevated);
  color: var(--color-text-subtle);
}

.provider-auth-popover__account strong {
  color: var(--color-text-strong);
}

.provider-auth-popover__attempt {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.provider-auth-popover__link,
.provider-auth-popover__action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  width: fit-content;
  border: 0;
  border-radius: 0.5rem;
  padding: 0.45rem 0.65rem;
  font-size: 0.84rem;
  background: var(--color-bg-elevated);
  color: inherit;
}

.provider-auth-popover__action--primary {
  background: var(--color-user-bg);
  color: var(--color-user-text);
  font-weight: 600;
}

.provider-auth-popover__link:hover,
.provider-auth-popover__action:hover {
  background: var(--color-bg-hover);
}

.provider-auth-popover__action--primary:hover {
  filter: brightness(1.03);
}

.provider-auth-popover__link:disabled,
.provider-auth-popover__action:disabled {
  opacity: 0.6;
  cursor: default;
}

.provider-auth-popover__input {
  width: 100%;
  resize: vertical;
  border: 1px solid var(--color-border-soft);
  border-radius: 0.5rem;
  background: var(--color-bg-elevated);
  color: inherit;
  padding: 0.55rem 0.65rem;
  font: inherit;
}

.provider-auth-popover__error {
  font-size: 0.82rem;
  color: var(--color-error);
}
</style>
