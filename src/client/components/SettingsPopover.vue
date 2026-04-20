<script setup lang="ts">
import { ExternalLink, KeyRound, LogOut, Save, Settings2 } from "lucide-vue-next";
import { computed, reactive, ref, watch } from "vue";
import { formatShortDateTime } from "@/client/lib/formatting";
import { useAppStore } from "@/client/stores/app";

const props = defineProps<{
  popoverId: string;
  anchorName: string;
}>();

const emit = defineEmits<{
  logout: [];
}>();

const store = useAppStore();
const connectPending = ref(false);
const completePending = ref(false);
const apiKeySaving = reactive<Record<string, boolean>>({
  google: false,
  openrouter: false,
});
const apiKeyInputs = reactive<Record<"google" | "openrouter", string>>({
  google: "",
  openrouter: "",
});
const braveSearchInput = ref("");
const braveSearchSaving = ref(false);
const assistantWorkspaceSaving = ref(false);
const authAttemptId = ref("");
const authUrl = ref("");
const authInstructions = ref("");
const authExpiresAt = ref<number | null>(null);
const authInput = ref("");
const authError = ref("");
const braveSearchError = ref("");
const apiKeyErrors = reactive<Record<string, string>>({
  google: "",
  openrouter: "",
});

const providerOrder = computed(() => {
  const supportedIds = new Set(["openai-codex", "google", "openrouter"]);
  return [...store.providerAuth.providers]
    .filter((provider) => supportedIds.has(provider.id))
    .sort((a, b) => {
      if (a.connected !== b.connected) {
        return a.connected ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
});
const hasOpenAICodexAttempt = computed(() => authAttemptId.value.length > 0);
const authExpiryLabel = computed(() =>
  authExpiresAt.value == null ? "" : formatShortDateTime(authExpiresAt.value),
);
const assistantWorkspaceId = computed(
  () => store.workspaces.find((workspace) => workspace.isAssistant)?.id ?? "",
);

function isCodexProvider(providerId: string): boolean {
  return providerId === "openai-codex";
}

function resetAttempt(): void {
  authAttemptId.value = "";
  authUrl.value = "";
  authInstructions.value = "";
  authExpiresAt.value = null;
  authInput.value = "";
}

function closePopover(): void {
  const element = document.getElementById(props.popoverId) as HTMLElement | null;
  element?.hidePopover?.();
}

function openAuthUrl(): void {
  if (!authUrl.value) {
    return;
  }
  window.open(authUrl.value, "_blank", "noopener,noreferrer");
}

function apiKeyTitle(providerId: "google" | "openrouter"): string {
  return providerId === "google" ? "Gemini API key" : "OpenRouter API key";
}

function apiKeyPlaceholder(providerId: "google" | "openrouter"): string {
  return providerId === "google" ? "Paste Gemini API key" : "Paste OpenRouter API key";
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
  } catch (error) {
    authError.value = error instanceof Error ? error.message : String(error);
  } finally {
    completePending.value = false;
  }
}

async function saveApiKey(providerId: "google" | "openrouter"): Promise<void> {
  const apiKey = apiKeyInputs[providerId].trim();
  if (!apiKey) {
    apiKeyErrors[providerId] = "Enter an API key";
    return;
  }

  apiKeySaving[providerId] = true;
  apiKeyErrors[providerId] = "";
  try {
    await store.setProviderApiKey(providerId, apiKey);
    apiKeyInputs[providerId] = "";
  } catch (error) {
    apiKeyErrors[providerId] = error instanceof Error ? error.message : String(error);
  } finally {
    apiKeySaving[providerId] = false;
  }
}

async function saveBraveSearchKey(): Promise<void> {
  const apiKey = braveSearchInput.value.trim();
  if (!apiKey) {
    braveSearchError.value = "Enter a Brave Search API key";
    return;
  }

  braveSearchSaving.value = true;
  braveSearchError.value = "";
  try {
    await store.setBraveSearchApiKey(apiKey);
    braveSearchInput.value = "";
  } catch (error) {
    braveSearchError.value = error instanceof Error ? error.message : String(error);
  } finally {
    braveSearchSaving.value = false;
  }
}

async function updateAssistantWorkspace(event: Event): Promise<void> {
  const workspaceId = (event.target as HTMLSelectElement).value.trim();
  assistantWorkspaceSaving.value = true;
  try {
    await store.setWorkspaceAssistant(workspaceId || undefined);
  } catch (error) {
    console.error(error);
  } finally {
    assistantWorkspaceSaving.value = false;
  }
}

function logout(): void {
  closePopover();
  emit("logout");
}

watch(
  () => document.getElementById(props.popoverId)?.matches(":popover-open"),
  (open) => {
    if (!open) {
      return;
    }

    authError.value = "";
    braveSearchError.value = "";
    apiKeyErrors.google = "";
    apiKeyErrors.openrouter = "";
    void store.refreshProviderAuthStatus();
  },
);
</script>

<template>
  <div
    :id="props.popoverId"
    class="settings-popover"
    :style="{ 'position-anchor': props.anchorName }"
    popover="auto"
  >
    <section class="settings-popover__section">
      <div class="settings-popover__section-header">
        <div class="settings-popover__section-title-row">
          <Settings2 :size="15" />
          <h2 class="settings-popover__section-title">Settings</h2>
        </div>
      </div>
    </section>

    <section class="settings-popover__section">
      <div class="settings-popover__group-title">Assistant workspace</div>
      <div class="settings-popover__copy">
        Choose which workspace gets the daily assistant entry point.
      </div>
      <select
        class="settings-popover__select"
        :value="assistantWorkspaceId"
        :disabled="assistantWorkspaceSaving"
        @change="updateAssistantWorkspace"
      >
        <option value="">None</option>
        <option v-for="workspace in store.workspaces" :key="workspace.id" :value="workspace.id">
          {{ workspace.label }}
        </option>
      </select>
    </section>

    <section class="settings-popover__section">
      <div class="settings-popover__group-title">Brave Search API key</div>
      <div class="settings-popover__provider-meta">
        {{ store.settings.braveSearchConfigured ? "API key saved" : "Not configured" }}
      </div>
      <div class="settings-popover__api-key-row">
        <input
          v-model="braveSearchInput"
          class="settings-popover__input"
          type="text"
          autocomplete="off"
          placeholder="Paste Brave Search API key"
          :disabled="braveSearchSaving"
        />
        <button
          class="settings-popover__action settings-popover__action--primary settings-popover__icon-button"
          type="button"
          :disabled="braveSearchSaving"
          :title="store.settings.braveSearchConfigured ? 'Replace key' : 'Save key'"
          :aria-label="store.settings.braveSearchConfigured ? 'Replace key' : 'Save key'"
          @click="saveBraveSearchKey"
        >
          <Save :size="16" />
        </button>
      </div>
      <div v-if="braveSearchError" class="settings-popover__error">{{ braveSearchError }}</div>
    </section>

    <section class="settings-popover__section">
      <div class="settings-popover__group-title">Auth</div>

      <section
        v-for="provider in providerOrder"
        :key="provider.id"
        class="settings-popover__provider"
      >
        <template v-if="isCodexProvider(provider.id)">
          <div class="settings-popover__header">
            <div>
              <div class="settings-popover__title">ChatGPT/Codex subscription</div>
              <div class="settings-popover__subtitle">Provider: openai-codex</div>
            </div>
            <span
              :class="[
                'settings-popover__badge',
                provider.connected
                  ? 'settings-popover__badge--connected'
                  : 'settings-popover__badge--disconnected',
              ]"
            >
              <KeyRound v-if="provider.connected" :size="13" />
              {{ provider.connected ? "Connected" : "Not connected" }}
            </span>
          </div>

          <div v-if="provider.connectedEmail" class="settings-popover__provider-meta">
            {{ provider.connectedEmail }}
          </div>

          <p class="settings-popover__copy">
            Sign in with your ChatGPT/Codex subscription to use <code>openai-codex/*</code>
            models.
          </p>

          <button
            class="settings-popover__action"
            type="button"
            :disabled="connectPending || completePending"
            @click="startOpenAICodexAuth"
          >
            {{
              connectPending
                ? "Starting…"
                : hasOpenAICodexAttempt
                  ? "Restart connect flow"
                  : provider.connected
                    ? "Reconnect account"
                    : "Connect ChatGPT/Codex"
            }}
          </button>

          <div v-if="hasOpenAICodexAttempt" class="settings-popover__attempt">
            <div v-if="authInstructions" class="settings-popover__help">
              {{ authInstructions }}
            </div>
            <div class="settings-popover__help">
              Open the sign-in page, finish login in the browser, then paste the localhost callback
              URL or just the authorization code here.
            </div>
            <div v-if="authExpiryLabel" class="settings-popover__help">
              Expires: {{ authExpiryLabel }}
            </div>

            <button class="settings-popover__link" type="button" @click="openAuthUrl">
              <ExternalLink :size="14" /> Open sign-in page
            </button>

            <textarea
              v-model="authInput"
              class="settings-popover__input settings-popover__textarea"
              rows="4"
              placeholder="Paste the localhost callback URL or the authorization code"
              :disabled="completePending"
            />

            <button
              class="settings-popover__action settings-popover__action--primary"
              type="button"
              :disabled="completePending || !authInput.trim()"
              @click="completeOpenAICodexAuth"
            >
              {{ completePending ? "Completing…" : "Complete connection" }}
            </button>
          </div>

          <div v-if="authError" class="settings-popover__error">{{ authError }}</div>
        </template>

        <template v-else>
          <div class="settings-popover__header">
            <div>
              <div class="settings-popover__title">
                {{ apiKeyTitle(provider.id as "google" | "openrouter") }}
              </div>
              <div class="settings-popover__subtitle">Provider: {{ provider.id }}</div>
            </div>
            <span
              :class="[
                'settings-popover__badge',
                provider.connected
                  ? 'settings-popover__badge--connected'
                  : 'settings-popover__badge--disconnected',
              ]"
            >
              {{ provider.connected ? "Connected" : "Not connected" }}
            </span>
          </div>

          <div class="settings-popover__provider-meta">
            {{
              provider.connected
                ? "API key saved"
                : "Save an API key to enable models for this provider."
            }}
          </div>

          <div class="settings-popover__api-key-row">
            <input
              v-model="apiKeyInputs[provider.id as 'google' | 'openrouter']"
              class="settings-popover__input"
              type="text"
              autocomplete="off"
              :placeholder="apiKeyPlaceholder(provider.id as 'google' | 'openrouter')"
              :disabled="apiKeySaving[provider.id]"
            />
            <button
              class="settings-popover__action settings-popover__action--primary settings-popover__icon-button"
              type="button"
              :disabled="apiKeySaving[provider.id]"
              :title="provider.connected ? 'Replace key' : 'Save key'"
              :aria-label="provider.connected ? 'Replace key' : 'Save key'"
              @click="saveApiKey(provider.id as 'google' | 'openrouter')"
            >
              <Save :size="16" />
            </button>
          </div>
          <div v-if="apiKeyErrors[provider.id]" class="settings-popover__error">
            {{ apiKeyErrors[provider.id] }}
          </div>
        </template>
      </section>
    </section>

    <section class="settings-popover__section settings-popover__section--logout">
      <button class="settings-popover__logout" type="button" @click="logout">
        <LogOut :size="14" /> Log out
      </button>
    </section>
  </div>
</template>

<style scoped>
.settings-popover {
  display: none;
}

.settings-popover:popover-open {
  position: fixed;
  position-area: block-end span-inline-end;
  position-try-fallbacks:
    block-end span-inline-start,
    block-start span-inline-end,
    block-start span-inline-start;
  width: min(30rem, calc(100vw - var(--safe-area-left) - var(--safe-area-right) - 1rem));
  max-width: calc(100vw - var(--safe-area-left) - var(--safe-area-right) - 1rem);
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
  margin: 0;
  padding: 0.65rem;
  border: 1px solid var(--color-border-soft);
  border-radius: 0.75rem;
  background: var(--color-bg-overlay);
  color: inherit;
  box-shadow: var(--color-shadow-popover);
  max-height: min(40rem, calc(100dvh - var(--safe-area-top) - var(--safe-area-bottom) - 2rem));
  overflow-y: auto;
}

.settings-popover::backdrop {
  background: var(--color-backdrop);
}

.settings-popover__section {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}

.settings-popover__section + .settings-popover__section {
  border-top: 1px solid var(--color-border-soft);
  padding-top: 0.7rem;
}

.settings-popover__section-header,
.settings-popover__section-title-row,
.settings-popover__header,
.settings-popover__api-key-row {
  display: flex;
  align-items: center;
}

.settings-popover__section-header,
.settings-popover__header {
  justify-content: space-between;
  gap: 0.5rem;
}

.settings-popover__section-title-row {
  gap: 0.45rem;
  color: var(--color-text-strong);
}

.settings-popover__section-title,
.settings-popover__title,
.settings-popover__group-title {
  margin: 0;
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--color-text-strong);
}

.settings-popover__provider {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}

.settings-popover__provider + .settings-popover__provider {
  border-top: 1px solid var(--color-border-soft);
  padding-top: 0.7rem;
}

.settings-popover__subtitle,
.settings-popover__copy,
.settings-popover__help,
.settings-popover__provider-meta {
  font-size: 0.82rem;
  color: var(--color-text-subtle);
}

.settings-popover__copy {
  margin: 0;
}

.settings-popover__badge {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  border-radius: 999px;
  padding: 0.18rem 0.5rem;
  font-size: 0.72rem;
  font-weight: 600;
  white-space: nowrap;
}

.settings-popover__badge--connected {
  background: color-mix(in srgb, var(--color-success) 18%, transparent);
  color: var(--color-success);
}

.settings-popover__badge--disconnected {
  background: var(--color-bg-elevated);
  color: var(--color-text-subtle);
}

.settings-popover__attempt {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.settings-popover__link,
.settings-popover__action,
.settings-popover__logout {
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

.settings-popover__action--primary {
  background: var(--color-user-bg);
  color: var(--color-user-text);
  font-weight: 600;
}

.settings-popover__logout {
  background: var(--color-error-soft);
  color: var(--color-error);
}

@media (hover: hover) {
  .settings-popover__link:hover,
  .settings-popover__action:hover {
    background: var(--color-bg-hover);
  }

  .settings-popover__action--primary:hover {
    filter: brightness(1.03);
  }

  .settings-popover__logout:hover {
    filter: brightness(1.03);
  }
}

.settings-popover__link:disabled,
.settings-popover__action:disabled,
.settings-popover__logout:disabled {
  opacity: 0.6;
  cursor: default;
}

.settings-popover__select,
.settings-popover__input {
  width: 100%;
  border: 1px solid var(--color-border-soft);
  border-radius: 0.5rem;
  background: var(--color-bg-elevated);
  color: inherit;
  padding: 0.55rem 0.65rem;
  font: inherit;
}

.settings-popover__input {
  font-family: var(--font-family-mono);
}

.settings-popover__textarea {
  resize: vertical;
}

.settings-popover__api-key-row {
  align-items: stretch;
  gap: 0.45rem;
}

.settings-popover__icon-button {
  flex: 0 0 auto;
  width: 2.75rem;
  min-width: 2.75rem;
  padding: 0;
  aspect-ratio: 1;
}

.settings-popover__section--logout {
  align-items: flex-start;
}

.settings-popover__error {
  font-size: 0.82rem;
  color: var(--color-error);
}
</style>
