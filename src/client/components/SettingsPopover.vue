<script setup lang="ts">
import { Bot, Check, ExternalLink, LogOut, Palette, Pencil, Save, X } from "@lucide/vue";
import { computed, reactive, ref, watch } from "vue";
import FullPopover from "@/client/components/FullPopover.vue";
import ModelConfigPopover from "@/client/components/ModelConfigPopover.vue";
import { formatShortDateTime } from "@/client/lib/formatting";
import { APP_COLOR_OPTIONS, type AppColor } from "@/shared/appearance";
import { useAppStore } from "@/client/stores/app";

const props = defineProps<{
  popoverId: string;
  anchorName: string;
}>();

const emit = defineEmits<{
  logout: [];
}>();

const BRAVE_SEARCH_ITEM_ID = "brave-search";
const AGENTS_ITEM_ID = "batty-agents";
const DEFAULT_MODEL_POPOVER_ID = "settings-default-model-popover";
const DEFAULT_MODEL_ANCHOR = "--settings-default-model-anchor";
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
const appearanceTitle = ref("");
const appearanceColor = ref<AppColor>("neutral");
const appearanceSaving = ref(false);
const appearanceError = ref("");
const defaultModelSaving = ref(false);
const defaultModelError = ref("");
const braveSearchInput = ref("");
const braveSearchSaving = ref(false);
const assistantWorkspaceSaving = ref(false);
const battyAgentsInput = ref("");
const battyAgentsLoading = ref(false);
const battyAgentsSaving = ref(false);
const battyAgentsError = ref("");
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
const defaultModelId = computed(() =>
  store.settings.defaultProvider && store.settings.defaultModel
    ? `${store.settings.defaultProvider}/${store.settings.defaultModel}`
    : undefined,
);
const defaultModel = computed(() =>
  store.models.find((model) => model.id === defaultModelId.value),
);
const defaultModelLabel = computed(
  () =>
    defaultModel.value?.label.split(" · ", 1)[0] ?? store.settings.defaultModel ?? "Select a model",
);
const defaultProviderLabel = computed(
  () => defaultModel.value?.provider ?? store.settings.defaultProvider ?? "Default provider",
);

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

function apiKeyPlaceholder(providerId: "google" | "openrouter"): string {
  return providerId === "google" ? "Paste Gemini API key" : "Paste OpenRouter API key";
}

async function loadBattyAgentsFile(): Promise<void> {
  expandedItemId.value = AGENTS_ITEM_ID;
  battyAgentsLoading.value = true;
  battyAgentsError.value = "";
  try {
    battyAgentsInput.value = await store.getBattyAgentsFile();
  } catch (error) {
    battyAgentsError.value = error instanceof Error ? error.message : String(error);
  } finally {
    battyAgentsLoading.value = false;
  }
}

async function toggleBattyAgentsEditor(): Promise<void> {
  if (isExpanded(AGENTS_ITEM_ID)) {
    expandedItemId.value = undefined;
    return;
  }

  await loadBattyAgentsFile();
}

async function saveBattyAgentsFile(): Promise<void> {
  battyAgentsSaving.value = true;
  battyAgentsError.value = "";
  try {
    battyAgentsInput.value = await store.setBattyAgentsFile(battyAgentsInput.value);
    expandedItemId.value = undefined;
  } catch (error) {
    battyAgentsError.value = error instanceof Error ? error.message : String(error);
  } finally {
    battyAgentsSaving.value = false;
  }
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

async function saveDefaultModel(modelId: string): Promise<void> {
  defaultModelSaving.value = true;
  defaultModelError.value = "";
  try {
    await store.setDefaultModel(modelId);
    document.getElementById(DEFAULT_MODEL_POPOVER_ID)?.hidePopover?.();
  } catch (error) {
    defaultModelError.value = error instanceof Error ? error.message : String(error);
  } finally {
    defaultModelSaving.value = false;
  }
}

async function saveAppearance(): Promise<void> {
  const title = appearanceTitle.value.trim();
  if (!title) {
    appearanceError.value = "Enter an app title";
    return;
  }

  appearanceSaving.value = true;
  appearanceError.value = "";
  try {
    await store.setAppearance({ title, color: appearanceColor.value });
    appearanceTitle.value = store.settings.appearance.title;
  } catch (error) {
    appearanceError.value = error instanceof Error ? error.message : String(error);
  } finally {
    appearanceSaving.value = false;
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

watch(
  () => store.settings.appearance,
  (appearance) => {
    appearanceTitle.value = appearance.title;
    appearanceColor.value = appearance.color;
  },
  { immediate: true },
);

function logout(): void {
  closePopover();
  emit("logout");
}

function handlePopoverToggle(event: Event): void {
  const open = (event as Event & { newState?: "open" | "closed" }).newState === "open";
  if (!open) {
    expandedItemId.value = undefined;
    return;
  }

  authError.value = "";
  appearanceError.value = "";
  defaultModelError.value = "";
  braveSearchError.value = "";
  battyAgentsError.value = "";
  apiKeyErrors.google = "";
  apiKeyErrors.openrouter = "";
  void store.refreshProviderAuthStatus();
}
</script>

<template>
  <FullPopover
    class="settings-popover"
    :popover-id="props.popoverId"
    :anchor-name="props.anchorName"
    title="Settings"
    close-label="Close settings"
    @toggle="handlePopoverToggle"
  >
    <div class="settings-popover__body">
      <section class="settings-popover__section">
        <div class="settings-popover__section-title-row">
          <Palette :size="15" />
          <div class="settings-popover__group-title">Appearance</div>
        </div>

        <label class="settings-popover__field">
          <span>App title</span>
          <input
            v-model="appearanceTitle"
            class="settings-popover__input settings-popover__input--title"
            type="text"
            maxlength="40"
            autocomplete="off"
            :disabled="appearanceSaving"
            @keydown.enter="saveAppearance"
          />
        </label>

        <fieldset class="settings-popover__color-fieldset">
          <legend>Color</legend>
          <div class="settings-popover__colors">
            <label
              v-for="color in APP_COLOR_OPTIONS"
              :key="color.id"
              class="settings-popover__color-option"
              :title="color.label"
            >
              <input
                v-model="appearanceColor"
                type="radio"
                name="app-color"
                :value="color.id"
                :disabled="appearanceSaving"
              />
              <span
                class="settings-popover__color-swatch"
                :style="{
                  backgroundImage: `linear-gradient(135deg, ${color.light} 50%, ${color.dark} 50%)`,
                }"
              >
                <Check v-if="appearanceColor === color.id" :size="15" :stroke-width="3" />
              </span>
              <span>{{ color.label }}</span>
            </label>
          </div>
        </fieldset>

        <button
          class="settings-popover__action settings-popover__action--primary"
          type="button"
          :disabled="appearanceSaving || !appearanceTitle.trim()"
          @click="saveAppearance"
        >
          <Save :size="14" /> {{ appearanceSaving ? "Saving…" : "Save appearance" }}
        </button>
        <div v-if="appearanceError" class="settings-popover__error" role="alert">
          {{ appearanceError }}
        </div>
      </section>

      <section class="settings-popover__section">
        <div class="settings-popover__group-title">Default model</div>
        <div class="settings-popover__help">Used when starting new sessions.</div>
        <button
          class="settings-popover__model-button"
          type="button"
          :style="{ 'anchor-name': DEFAULT_MODEL_ANCHOR }"
          :popovertarget="DEFAULT_MODEL_POPOVER_ID"
          :disabled="defaultModelSaving"
          aria-label="Choose default model and provider"
          @click="store.refreshModels"
        >
          <Bot :size="17" />
          <span class="settings-popover__model-info">
            <strong>{{ defaultModelLabel }}</strong>
            <span>{{ defaultProviderLabel }}</span>
          </span>
        </button>
        <ModelConfigPopover
          :popover-id="DEFAULT_MODEL_POPOVER_ID"
          :anchor-name="DEFAULT_MODEL_ANCHOR"
          :models="store.models"
          :current-model-id="defaultModelId"
          current-thinking-level=""
          :thinking-options="[]"
          @set-model="saveDefaultModel"
        />
        <div v-if="defaultModelError" class="settings-popover__error" role="alert">
          {{ defaultModelError }}
        </div>
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
        <div class="settings-popover__group-title">Batty AGENTS file</div>

        <article class="settings-popover__item">
          <div class="settings-popover__item-top">
            <div class="settings-popover__item-meta">
              <strong>AGENTS.md</strong>
              <div class="settings-popover__help">Edit <code>.batty/AGENTS.md</code>.</div>
            </div>

            <button
              class="settings-popover__icon-btn"
              type="button"
              :disabled="battyAgentsLoading || battyAgentsSaving"
              @click="toggleBattyAgentsEditor"
            >
              <component :is="isExpanded(AGENTS_ITEM_ID) ? X : Pencil" :size="14" />
            </button>
          </div>

          <div v-if="isExpanded(AGENTS_ITEM_ID)" class="settings-popover__editor">
            <textarea
              v-model="battyAgentsInput"
              class="settings-popover__input settings-popover__textarea"
              rows="12"
              spellcheck="false"
              placeholder="Write AGENTS instructions"
              :disabled="battyAgentsLoading || battyAgentsSaving"
            />
            <div class="settings-popover__editor-actions">
              <button
                class="settings-popover__action settings-popover__action--primary"
                type="button"
                :disabled="battyAgentsLoading || battyAgentsSaving"
                @click="saveBattyAgentsFile"
              >
                <Save :size="14" />
                {{ battyAgentsLoading ? "Loading…" : battyAgentsSaving ? "Saving…" : "Save" }}
              </button>
            </div>
            <div v-if="battyAgentsError" class="settings-popover__error">
              {{ battyAgentsError }}
            </div>
          </div>
        </article>
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
            <div v-if="braveSearchError" class="settings-popover__error">
              {{ braveSearchError }}
            </div>
          </div>
        </article>

        <article
          v-for="provider in providerOrder"
          :key="provider.id"
          class="settings-popover__item"
        >
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

                <a
                  class="settings-popover__link"
                  :href="authUrl"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink :size="14" /> Open sign-in page
                </a>

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
  </FullPopover>
</template>

<style scoped>
.settings-popover {
  background: var(--color-bg-panel-strong);
}

.settings-popover :deep(.full-popover__header) {
  border-bottom: 0;
  background: var(--color-bg-panel-strong);
}

.settings-popover__body {
  display: flex;
  height: 100%;
  min-height: 0;
  flex-direction: column;
  overflow-y: auto;
  background: var(--color-bg-app);
}

.settings-popover__section {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
  padding: 0.75rem 1rem;
}

.settings-popover__section + .settings-popover__section {
  border-top: 1px solid var(--color-border-soft);
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
  background: var(--color-bg-app);
  color: inherit;
  padding: 0.55rem 0.65rem;
  font: inherit;
}

.settings-popover__input {
  font-family: var(--font-family-mono);
}

.settings-popover__input--title {
  font-family: inherit;
}

.settings-popover__model-button {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.55rem 0.65rem;
  border: 1px solid var(--color-border-soft);
  border-radius: 0.55rem;
  background: var(--color-bg-app);
  color: var(--color-text-muted);
  text-align: left;
}

.settings-popover__model-info {
  min-width: 0;
  display: grid;
  line-height: 1.15;
}

.settings-popover__model-info strong,
.settings-popover__model-info span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.settings-popover__model-info strong {
  color: var(--color-text-strong);
  font-size: 0.84rem;
}

.settings-popover__model-info span {
  color: var(--color-text-subtle);
  font-size: 0.72rem;
  text-transform: capitalize;
}

.settings-popover__field,
.settings-popover__color-fieldset {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  margin: 0;
  padding: 0;
  border: 0;
  color: var(--color-text-muted);
  font-size: 0.78rem;
}

.settings-popover__colors {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(4.3rem, 1fr));
  gap: 0.45rem;
}

.settings-popover__color-option {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.2rem;
  color: var(--color-text-muted);
  cursor: pointer;
}

.settings-popover__color-option input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
}

.settings-popover__color-swatch {
  position: relative;
  display: grid;
  place-items: center;
  width: 2.4rem;
  height: 2.4rem;
  overflow: hidden;
  border: 2px solid transparent;
  border-radius: 999px;
  background-origin: border-box;
  color: #ffffff;
  filter: drop-shadow(0 0 0.18rem oklch(0 0 0 / 0.35));
}

.settings-popover__color-swatch svg {
  box-sizing: content-box;
  padding: 0.12rem;
  border-radius: 999px;
  background: oklch(0.2 0 0 / 0.72);
  box-shadow: 0 0 0 1px oklch(1 0 0 / 0.35);
}

.settings-popover__color-option input:checked + .settings-popover__color-swatch {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 2px var(--color-bg-overlay);
}

.settings-popover__color-option input:focus-visible + .settings-popover__color-swatch {
  outline: 2px solid var(--color-accent);
  outline-offset: 3px;
}

.settings-popover__textarea {
  resize: vertical;
}

.settings-popover__item {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
  margin-inline: -1rem;
  padding: 0.55rem 1rem;
  background: transparent;
}

.settings-popover__item + .settings-popover__item {
  margin-top: -0.55rem;
  border-top: 1px solid var(--color-border-soft);
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
  text-decoration: none;
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
  .settings-popover__icon-btn:hover,
  .settings-popover__model-button:hover:not(:disabled) {
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
.settings-popover__model-button:disabled,
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
