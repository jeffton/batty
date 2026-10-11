<script setup lang="ts">
import { ExternalLink, Pencil, Save, X } from "@lucide/vue";
import { computed, reactive, ref, watch } from "vue";
import { useAppStore } from "@/client/stores/app";
import { formatShortDateTime } from "@/client/lib/formatting";
import { watchOpenAIAuthAttempt } from "@/client/lib/provider-auth";

const props = defineProps<{ open: boolean }>();
const expandedItemId = defineModel<string>("expandedItemId");
const store = useAppStore();
const BRAVE_SEARCH_ITEM_ID = "brave-search";
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
  const supportedIds = new Set(["openai", "google", "openrouter"]);
  return [...store.providerAuth.providers]
    .filter((provider) => supportedIds.has(provider.id))
    .sort((a, b) => {
      if (a.connected !== b.connected) {
        return a.connected ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
});
const hasOpenAIAttempt = computed(() => authAttemptId.value.length > 0);
const authExpiryLabel = computed(() =>
  authExpiresAt.value == null ? "" : formatShortDateTime(authExpiresAt.value),
);
function isOpenAIProvider(providerId: string): boolean {
  return providerId === "openai";
}

function itemTitle(itemId: string): string {
  if (itemId === BRAVE_SEARCH_ITEM_ID) {
    return "Brave Search API key";
  }
  if (itemId === "openai") {
    return "ChatGPT subscription";
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
  if (itemId === "openai") {
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

function apiKeyPlaceholder(providerId: "google" | "openrouter"): string {
  return providerId === "google" ? "Paste Gemini API key" : "Paste OpenRouter API key";
}

async function startOpenAIAuth(): Promise<void> {
  resetAttempt();
  expandedItemId.value = "openai";
  connectPending.value = true;
  authError.value = "";
  try {
    const result = await store.startOpenAIProviderAuth();
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

async function completeOpenAIAuth(): Promise<void> {
  if (!authAttemptId.value || !authInput.value.trim()) {
    return;
  }

  completePending.value = true;
  authError.value = "";
  try {
    await store.completeOpenAIProviderAuth(authAttemptId.value, authInput.value.trim());
    resetAttempt();
    expandedItemId.value = undefined;
  } catch (error) {
    authError.value = error instanceof Error ? error.message : String(error);
  } finally {
    completePending.value = false;
  }
}

watchOpenAIAuthAttempt(
  computed(() => (completePending.value ? "" : authAttemptId.value)),
  async () => {
    resetAttempt();
    await store.bootstrap();
  },
  (error) => {
    resetAttempt();
    authError.value = error instanceof Error ? error.message : String(error);
  },
);

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

watch(
  () => props.open,
  (open) => {
    if (open) {
      authError.value = "";
      braveSearchError.value = "";
      apiKeyErrors.google = "";
      apiKeyErrors.openrouter = "";
      void store.refreshProviderAuthStatus();
    }
  },
);
</script>

<template>
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
            provider.id === 'openai' ? connectPending || completePending : apiKeySaving[provider.id]
          "
          @click="toggleExpanded(provider.id)"
        >
          <component :is="isExpanded(provider.id) ? X : Pencil" :size="14" />
        </button>
      </div>

      <div v-if="isExpanded(provider.id)" class="settings-popover__editor">
        <template v-if="isOpenAIProvider(provider.id)">
          <div class="settings-popover__help">
            Sign in with your ChatGPT subscription to use <code>openai/*</code>
            models.
          </div>

          <button
            class="settings-popover__action"
            type="button"
            :disabled="connectPending || completePending"
            @click="startOpenAIAuth"
          >
            {{
              connectPending
                ? "Starting…"
                : hasOpenAIAttempt
                  ? "Restart connect flow"
                  : provider.connected
                    ? "Reconnect account"
                    : "Connect ChatGPT"
            }}
          </button>

          <div v-if="hasOpenAIAttempt" class="settings-popover__attempt">
            <div v-if="authInstructions" class="settings-popover__help">
              {{ authInstructions }}
            </div>
            <div class="settings-popover__help">
              Finish sign-in in your browser. If this stays open, paste the full callback URL from
              the address bar, even if the page cannot load.
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
              placeholder="Paste the full http://127.0.0.1:1455/auth/callback URL"
              :disabled="completePending"
            />

            <button
              class="settings-popover__action settings-popover__action--primary"
              type="button"
              :disabled="completePending || !authInput.trim()"
              @click="completeOpenAIAuth"
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
</template>
