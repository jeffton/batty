<script setup lang="ts">
import { ExternalLink, LogOut, Pencil, Save, Settings2, X } from "lucide-vue-next";
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

const BRAVE_SEARCH_ITEM_ID = "brave-search";
const store = useAppStore();
const connectPending = ref(false);
const completePending = ref(false);
const expandedItemId = ref<string>();
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
const uiThemeSaving = ref(false);
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
const uiTheme = computed(() => store.settings.uiTheme);

function isCodexProvider(providerId: string): boolean {
  return providerId === "openai-codex";
}

function itemTitle(itemId: string): string {
  if (itemId === BRAVE_SEARCH_ITEM_ID) {
    return "Brave Search API key";
  }
  if (itemId === "openai-codex") {
    return "ChatGPT/Codex subscription";
  }
  if (itemId === "google") {
    return "Gemini API key";
  }
  if (itemId === "openrouter") {
    return "OpenRouter API key";
  }
  return itemId;
}

function itemConnected(itemId: string): boolean {
  if (itemId === BRAVE_SEARCH_ITEM_ID) {
    return store.settings.braveSearchConfigured;
  }

  const provider = store.providerAuth.providers.find((candidate) => candidate.id === itemId);
  return provider?.connected === true;
}

function itemStatusLabel(itemId: string): string {
  if (itemId === "openai-codex") {
    const provider = store.providerAuth.providers.find((candidate) => candidate.id === itemId);
    if (provider?.connected && provider.connectedEmail) {
      return `Connected · ${provider.connectedEmail}`;
    }
  }

  return itemConnected(itemId) ? "Connected" : "Not connected";
}

function isExpanded(itemId: string): boolean {
  return expandedItemId.value === itemId;
}

function toggleExpanded(itemId: string): void {
  expandedItemId.value = expandedItemId.value === itemId ? undefined : itemId;
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

function apiKeyPlaceholder(providerId: "google" | "openrouter"): string {
  return providerId === "google" ? "Paste Gemini API key" : "Paste OpenRouter API key";
}

async function startOpenAICodexAuth(): Promise<void> {
  expandedItemId.value = "openai-codex";
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
    expandedItemId.value = undefined;
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

  expandedItemId.value = providerId;
  apiKeySaving[providerId] = true;
  apiKeyErrors[providerId] = "";
  try {
    await store.setProviderApiKey(providerId, apiKey);
    apiKeyInputs[providerId] = "";
    expandedItemId.value = undefined;
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

  expandedItemId.value = BRAVE_SEARCH_ITEM_ID;
  braveSearchSaving.value = true;
  braveSearchError.value = "";
  try {
    await store.setBraveSearchApiKey(apiKey);
    braveSearchInput.value = "";
    expandedItemId.value = undefined;
  } catch (error) {
    braveSearchError.value = error instanceof Error ? error.message : String(error);
  } finally {
    braveSearchSaving.value = false;
  }
}

async function updateUiTheme(event: Event): Promise<void> {
  const uiTheme = (event.target as HTMLSelectElement).value;
  if (uiTheme !== "neon-reef" && uiTheme !== "serious-business") {
    return;
  }

  uiThemeSaving.value = true;
  try {
    await store.setUiTheme(uiTheme);
  } catch (error) {
    console.error(error);
  } finally {
    uiThemeSaving.value = false;
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
      expandedItemId.value = undefined;
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
      <div class="settings-popover__group-title">Theme</div>
      <select
        class="settings-popover__select"
        :value="uiTheme"
        :disabled="uiThemeSaving"
        @change="updateUiTheme"
      >
        <option value="neon-reef">Neon reef</option>
        <option value="serious-business">Serious business</option>
      </select>
    </section>

    <section class="settings-popover__section">
      <div class="settings-popover__group-title">Assistant workspace</div>
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
      <div class="settings-popover__group-title">Auth</div>

      <article class="settings-popover__item">
        <div class="settings-popover__item-top">
          <div class="settings-popover__item-meta">
            <strong>{{ itemTitle(BRAVE_SEARCH_ITEM_ID) }}</strong>
            <div class="settings-popover__item-status-row">
              <span
                :class="[
                  'settings-popover__badge',
                  itemConnected(BRAVE_SEARCH_ITEM_ID)
                    ? 'settings-popover__badge--connected'
                    : 'settings-popover__badge--disconnected',
                ]"
              >
                {{ itemStatusLabel(BRAVE_SEARCH_ITEM_ID) }}
              </span>
            </div>
          </div>

          <button
            class="settings-popover__icon-btn"
            type="button"
            :disabled="braveSearchSaving"
            @click="toggleExpanded(BRAVE_SEARCH_ITEM_ID)"
          >
            <component :is="isExpanded(BRAVE_SEARCH_ITEM_ID) ? X : Pencil" :size="14" />
          </button>
        </div>

        <div v-if="isExpanded(BRAVE_SEARCH_ITEM_ID)" class="settings-popover__editor">
          <input
            v-model="braveSearchInput"
            class="settings-popover__input"
            type="text"
            autocomplete="off"
            placeholder="Paste Brave Search API key"
            :disabled="braveSearchSaving"
          />
          <div class="settings-popover__editor-actions">
            <button
              class="settings-popover__action settings-popover__action--primary"
              type="button"
              :disabled="braveSearchSaving"
              @click="saveBraveSearchKey"
            >
              <Save :size="14" /> {{ braveSearchSaving ? "Saving…" : "Save" }}
            </button>
          </div>
          <div v-if="braveSearchError" class="settings-popover__error">{{ braveSearchError }}</div>
        </div>
      </article>

      <article v-for="provider in providerOrder" :key="provider.id" class="settings-popover__item">
        <div class="settings-popover__item-top">
          <div class="settings-popover__item-meta">
            <strong>{{ itemTitle(provider.id) }}</strong>
            <div class="settings-popover__item-status-row">
              <span
                :class="[
                  'settings-popover__badge',
                  itemConnected(provider.id)
                    ? 'settings-popover__badge--connected'
                    : 'settings-popover__badge--disconnected',
                ]"
              >
                {{ itemStatusLabel(provider.id) }}
              </span>
            </div>
          </div>

          <button
            class="settings-popover__icon-btn"
            type="button"
            :disabled="
              provider.id === 'openai-codex'
                ? connectPending || completePending
                : apiKeySaving[provider.id]
            "
            @click="toggleExpanded(provider.id)"
          >
            <component :is="isExpanded(provider.id) ? X : Pencil" :size="14" />
          </button>
        </div>

        <div v-if="isExpanded(provider.id)" class="settings-popover__editor">
          <template v-if="isCodexProvider(provider.id)">
            <div class="settings-popover__help">
              Sign in with your ChatGPT/Codex subscription to use <code>openai-codex/*</code>
              models.
            </div>

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
                Open the sign-in page, finish login in the browser, then paste the localhost
                callback URL or just the authorization code here.
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
            <input
              v-model="apiKeyInputs[provider.id as 'google' | 'openrouter']"
              class="settings-popover__input"
              type="text"
              autocomplete="off"
              :placeholder="apiKeyPlaceholder(provider.id as 'google' | 'openrouter')"
              :disabled="apiKeySaving[provider.id]"
            />
            <div class="settings-popover__editor-actions">
              <button
                class="settings-popover__action settings-popover__action--primary"
                type="button"
                :disabled="apiKeySaving[provider.id]"
                @click="saveApiKey(provider.id as 'google' | 'openrouter')"
              >
                <Save :size="14" /> {{ apiKeySaving[provider.id] ? "Saving…" : "Save" }}
              </button>
            </div>
            <div v-if="apiKeyErrors[provider.id]" class="settings-popover__error">
              {{ apiKeyErrors[provider.id] }}
            </div>
          </template>
        </div>
      </article>
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
  padding-top: 0.7rem;
}

.settings-popover__section-header,
.settings-popover__section-title-row,
.settings-popover__item-top {
  display: flex;
  align-items: center;
}

.settings-popover__section-header,
.settings-popover__item-top {
  justify-content: space-between;
  gap: 0.5rem;
}

.settings-popover__section-title-row {
  gap: 0.45rem;
  color: var(--color-text-strong);
}

.settings-popover__section-title,
.settings-popover__group-title {
  margin: 0;
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--color-text-strong);
}

.settings-popover__select,
.settings-popover__input {
  width: 100%;
  border: 1px solid var(--color-border-soft);
  border-radius: 0.55rem;
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

.settings-popover__item {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
  padding: 0.55rem;
  border-radius: 0.65rem;
  background: var(--color-bg-panel);
  border: 1px solid var(--color-border-soft);
}

.settings-popover__item-meta {
  display: flex;
  flex-direction: column;
  gap: 0.12rem;
  min-width: 0;
  flex: 1;
}

.settings-popover__item-meta strong {
  overflow: hidden;
  text-overflow: ellipsis;
}

.settings-popover__item-meta strong {
  font-size: 0.84rem;
  color: var(--color-text-strong);
}

.settings-popover__item-status-row {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  flex-wrap: wrap;
}

.settings-popover__help {
  font-size: 0.78rem;
  color: var(--color-text-subtle);
}

.settings-popover__editor,
.settings-popover__attempt {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.settings-popover__editor-actions {
  display: flex;
  justify-content: flex-start;
}

.settings-popover__action,
.settings-popover__link,
.settings-popover__logout,
.settings-popover__icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  border: 0;
  border-radius: 0.45rem;
  font-size: 0.82rem;
}

.settings-popover__action,
.settings-popover__link,
.settings-popover__logout {
  width: fit-content;
  padding: 0.45rem 0.65rem;
  background: var(--color-bg-elevated);
  color: inherit;
}

.settings-popover__action--primary {
  background: var(--color-bg-selection);
  color: var(--color-accent-strong);
  font-weight: 600;
}

.settings-popover__logout {
  background: var(--color-error-soft);
  color: var(--color-error);
}

.settings-popover__icon-btn {
  background: transparent;
  color: var(--color-text-muted);
  padding: 0.45rem;
}

.settings-popover__badge {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  width: fit-content;
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

@media (hover: hover) {
  .settings-popover__action:hover,
  .settings-popover__link:hover,
  .settings-popover__icon-btn:hover {
    background: var(--color-bg-hover);
  }

  .settings-popover__action--primary:hover,
  .settings-popover__logout:hover {
    filter: brightness(1.03);
  }
}

.settings-popover__action:disabled,
.settings-popover__link:disabled,
.settings-popover__logout:disabled,
.settings-popover__icon-btn:disabled,
.settings-popover__select:disabled,
.settings-popover__input:disabled {
  opacity: 0.6;
  cursor: default;
}

.settings-popover__section--logout {
  align-items: flex-start;
}

.settings-popover__error {
  font-size: 0.78rem;
  color: var(--color-error);
}
</style>
