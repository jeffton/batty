<script setup lang="ts">
import type { ModelOption } from "@/shared/types";
import ThinkingLevelPicker from "@/client/components/ThinkingLevelPicker.vue";
import { Copy, ExternalLink, Search } from "lucide-vue-next";
import { computed, ref, watch } from "vue";
import { formatShortDateTime } from "@/client/lib/formatting";
import { useAppStore } from "@/client/stores/app";

const props = defineProps<{
  popoverId: string;
  anchorName: string;
  models: ModelOption[];
  currentModelId?: string;
  currentThinkingLevel: string;
  thinkingOptions: string[];
}>();

const emit = defineEmits<{
  setModel: [modelId: string];
  setThinkingLevel: [thinkingLevel: string];
  close: [];
}>();

const store = useAppStore();
const modelFilter = ref("");
const connectPending = ref(false);
const completePending = ref(false);
const copiedAuthUrl = ref(false);
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

const filteredModels = computed(() => {
  const query = modelFilter.value.toLowerCase().trim();
  const models = query
    ? props.models.filter(
        (m) =>
          m.label.toLowerCase().includes(query) ||
          m.provider.toLowerCase().includes(query) ||
          m.id.toLowerCase().includes(query),
      )
    : props.models;

  return [...models].sort((a, b) => {
    const providerCmp = a.provider.localeCompare(b.provider);
    if (providerCmp !== 0) return providerCmp;
    return shortModelLabel(a).localeCompare(shortModelLabel(b));
  });
});

function shortModelLabel(model: Pick<ModelOption, "label">): string {
  return model.label.split(" · ", 1)[0] ?? model.label;
}

function openAuthUrl(): void {
  if (!authUrl.value) {
    return;
  }
  window.open(authUrl.value, "_blank", "noopener,noreferrer");
}

async function copyAuthUrl(): Promise<void> {
  if (!authUrl.value) {
    return;
  }

  await navigator.clipboard.writeText(authUrl.value);
  copiedAuthUrl.value = true;
  window.setTimeout(() => {
    copiedAuthUrl.value = false;
  }, 1500);
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
    authAttemptId.value = "";
    authUrl.value = "";
    authInstructions.value = "";
    authExpiresAt.value = null;
    authInput.value = "";
    emit("close");
  } catch (error) {
    authError.value = error instanceof Error ? error.message : String(error);
  } finally {
    completePending.value = false;
  }
}

// Reset filter when popover opens
watch(
  () => document.getElementById(props.popoverId)?.matches(":popover-open"),
  (open) => {
    if (!open) {
      return;
    }

    modelFilter.value = "";
    authError.value = "";
    void store.refreshProviderAuthStatus();
  },
);
</script>

<template>
  <div
    :id="props.popoverId"
    class="mc-popover"
    :style="{ 'position-anchor': props.anchorName }"
    popover="auto"
  >
    <ThinkingLevelPicker
      v-if="props.thinkingOptions.length > 0"
      :options="props.thinkingOptions"
      :current="props.currentThinkingLevel"
      @change="emit('setThinkingLevel', $event)"
    />

    <section class="mc-popover__provider-auth">
      <div class="mc-popover__provider-auth-header">
        <div>
          <div class="mc-popover__provider-auth-title">Connect ChatGPT/Codex subscription</div>
          <div class="mc-popover__provider-auth-subtitle">Provider: openai-codex</div>
        </div>
        <span
          :class="[
            'mc-popover__provider-auth-badge',
            openAICodexStatus?.connected
              ? 'mc-popover__provider-auth-badge--connected'
              : 'mc-popover__provider-auth-badge--disconnected',
          ]"
        >
          {{ openAICodexStatus?.connected ? "Connected" : "Not connected" }}
        </span>
      </div>

      <p class="mc-popover__provider-auth-copy">
        Sign in with your ChatGPT/Codex subscription to unlock <code>openai-codex/*</code>
        models in Batty.
      </p>

      <button
        class="mc-popover__provider-auth-action"
        type="button"
        :disabled="connectPending || completePending"
        @click="startOpenAICodexAuth"
      >
        {{
          connectPending
            ? "Starting…"
            : hasOpenAICodexAttempt
              ? "Restart connect flow"
              : "Start connect flow"
        }}
      </button>

      <div v-if="hasOpenAICodexAttempt" class="mc-popover__provider-auth-attempt">
        <div v-if="authInstructions" class="mc-popover__provider-auth-help">
          {{ authInstructions }}
        </div>
        <div v-if="authExpiryLabel" class="mc-popover__provider-auth-help">
          Expires: {{ authExpiryLabel }}
        </div>

        <div class="mc-popover__provider-auth-url-row">
          <button class="mc-popover__provider-auth-link" type="button" @click="openAuthUrl">
            <ExternalLink :size="14" /> Open sign-in page
          </button>
          <button class="mc-popover__provider-auth-link" type="button" @click="copyAuthUrl">
            <Copy :size="14" /> {{ copiedAuthUrl ? "Copied" : "Copy URL" }}
          </button>
        </div>

        <textarea :value="authUrl" class="mc-popover__provider-auth-url" rows="3" readonly />

        <textarea
          v-model="authInput"
          class="mc-popover__provider-auth-input"
          rows="4"
          placeholder="Paste the final callback URL or the authorization code"
          :disabled="completePending"
        />

        <button
          class="mc-popover__provider-auth-action mc-popover__provider-auth-action--primary"
          type="button"
          :disabled="completePending || !authInput.trim()"
          @click="completeOpenAICodexAuth"
        >
          {{ completePending ? "Completing…" : "Complete connection" }}
        </button>
      </div>

      <div v-if="authError" class="mc-popover__provider-auth-error">{{ authError }}</div>
    </section>

    <div class="mc-popover__search-row">
      <Search :size="14" class="mc-popover__search-icon" />
      <input
        v-model="modelFilter"
        class="mc-popover__search"
        type="text"
        placeholder="Filter models…"
      />
    </div>

    <div class="mc-popover__models">
      <button
        v-for="model in filteredModels"
        :key="model.id"
        type="button"
        :class="['mc-popover__model', model.id === props.currentModelId ? 'is-active' : '']"
        @click="emit('setModel', model.id)"
      >
        <span class="mc-popover__model-name">{{ shortModelLabel(model) }}</span>
        <span class="mc-popover__model-provider">{{ model.provider }}</span>
      </button>
      <div v-if="filteredModels.length === 0" class="mc-popover__empty">No models match.</div>
    </div>
  </div>
</template>

<style scoped>
.mc-popover {
  display: none;
}

.mc-popover:popover-open {
  position: fixed;
  position-area: block-end span-inline-start;
  position-try-fallbacks:
    block-end span-inline-end,
    block-start span-inline-start,
    block-start span-inline-end;
  width: min(22rem, calc(100vw - var(--safe-area-left) - var(--safe-area-right) - 1rem));
  max-width: calc(100vw - var(--safe-area-left) - var(--safe-area-right) - 1rem);
  height: auto;
  max-height: min(32rem, calc(100dvh - var(--safe-area-top) - var(--safe-area-bottom) - 4rem));
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0.5rem;
  border: 1px solid var(--color-border-soft);
  border-radius: 0.75rem;
  background: var(--color-bg-overlay);
  color: inherit;
  box-shadow: var(--color-shadow-popover);
  gap: 0.35rem;
}

.mc-popover::backdrop {
  background: var(--color-backdrop);
}

.mc-popover__provider-auth {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  padding: 0.5rem;
  border: 1px solid var(--color-border-soft);
  border-radius: 0.65rem;
  background: var(--color-bg-panel);
}

.mc-popover__provider-auth-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.5rem;
}

.mc-popover__provider-auth-title {
  font-size: 0.88rem;
  font-weight: 600;
  color: var(--color-text-strong);
}

.mc-popover__provider-auth-subtitle,
.mc-popover__provider-auth-help,
.mc-popover__provider-auth-copy {
  font-size: 0.8rem;
  color: var(--color-text-subtle);
}

.mc-popover__provider-auth-copy {
  margin: 0;
}

.mc-popover__provider-auth-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  padding: 0.15rem 0.5rem;
  font-size: 0.72rem;
  font-weight: 600;
  white-space: nowrap;
}

.mc-popover__provider-auth-badge--connected {
  background: color-mix(in srgb, var(--color-success) 18%, transparent);
  color: var(--color-success);
}

.mc-popover__provider-auth-badge--disconnected {
  background: var(--color-bg-elevated);
  color: var(--color-text-subtle);
}

.mc-popover__provider-auth-attempt {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}

.mc-popover__provider-auth-url-row {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
}

.mc-popover__provider-auth-link,
.mc-popover__provider-auth-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  border: 0;
  border-radius: 0.5rem;
  padding: 0.45rem 0.65rem;
  font-size: 0.84rem;
  background: var(--color-bg-elevated);
  color: inherit;
  cursor: pointer;
}

.mc-popover__provider-auth-action {
  width: fit-content;
}

.mc-popover__provider-auth-action--primary {
  background: var(--color-user-bg);
  color: var(--color-user-text);
  font-weight: 600;
}

.mc-popover__provider-auth-link:hover,
.mc-popover__provider-auth-action:hover {
  background: var(--color-bg-hover);
}

.mc-popover__provider-auth-action--primary:hover {
  filter: brightness(1.03);
}

.mc-popover__provider-auth-link:disabled,
.mc-popover__provider-auth-action:disabled {
  opacity: 0.6;
  cursor: default;
}

.mc-popover__provider-auth-url,
.mc-popover__provider-auth-input {
  width: 100%;
  resize: vertical;
  border: 1px solid var(--color-border-soft);
  border-radius: 0.5rem;
  background: var(--color-bg-elevated);
  color: inherit;
  padding: 0.55rem 0.65rem;
  font: inherit;
}

.mc-popover__provider-auth-error {
  font-size: 0.8rem;
  color: var(--color-error);
}

.mc-popover__search-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.35rem 0.5rem;
  background: var(--color-bg-elevated);
  border-radius: 0.5rem;
}

.mc-popover__search-icon {
  color: var(--color-text-subtle);
  flex-shrink: 0;
}

.mc-popover__search {
  flex: 1;
  border: 0;
  background: transparent;
  color: inherit;
  font-size: 0.88rem;
  outline: none;
  padding: 0;
}

.mc-popover__models {
  flex: 0 1 auto;
  min-height: min(14rem, calc(100dvh - var(--safe-area-top) - var(--safe-area-bottom) - 12rem));
  max-height: min(22rem, calc(100dvh - var(--safe-area-top) - var(--safe-area-bottom) - 12rem));
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.mc-popover__model {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
  width: 100%;
  text-align: left;
  border: 0;
  border-radius: 0.4rem;
  background: transparent;
  color: inherit;
  padding: 0.4rem 0.5rem;
  font-size: 0.88rem;
  transition: background 80ms ease;
}

.mc-popover__model:hover:not(.is-active) {
  background: var(--color-bg-hover);
}

.mc-popover__model.is-active {
  background: var(--color-user-bg);
  color: var(--color-user-text);
  font-weight: 600;
}

.mc-popover__model-name {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mc-popover__model-provider {
  font-size: 0.78rem;
  color: var(--color-text-subtle);
  text-transform: capitalize;
  flex-shrink: 0;
}

.mc-popover__empty {
  padding: 0.6rem 0.5rem;
  color: var(--color-text-subtle);
  font-size: 0.85rem;
}
</style>
