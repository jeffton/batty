<script setup lang="ts">
import { Check, ExternalLink, LogIn, Save } from "@lucide/vue";
import SettingsCredential from "./SettingsCredential.vue";
import SettingsField from "./SettingsField.vue";
import { computed, reactive, ref, watch } from "vue";
import { useAppStore } from "@/client/stores/app";
import { formatShortDateTime } from "@/client/lib/formatting";
import { watchProviderAuthAttempt } from "@/client/lib/provider-auth";
import {
  SUBSCRIPTION_PROVIDERS,
  isSubscriptionProvider,
  type SubscriptionProviderId,
} from "@/shared/provider-auth";

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
const authProviderId = ref<SubscriptionProviderId>("openai");
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
  const orderedIds = ["openai", "openai-codex", "anthropic", "google", "openrouter"];
  return store.providerAuth.providers
    .filter((provider) => orderedIds.includes(provider.id))
    .sort((a, b) => orderedIds.indexOf(a.id) - orderedIds.indexOf(b.id));
});
const hasAuthAttempt = computed(() => authAttemptId.value.length > 0);
const authExpiryLabel = computed(() =>
  authExpiresAt.value == null ? "" : formatShortDateTime(authExpiresAt.value),
);
function itemTitle(itemId: string): string {
  if (itemId === BRAVE_SEARCH_ITEM_ID) {
    return "Brave Search API key";
  }
  if (isSubscriptionProvider(itemId)) {
    return SUBSCRIPTION_PROVIDERS[itemId].name;
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
  if (isSubscriptionProvider(itemId)) {
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

async function startSubscriptionAuth(providerId: SubscriptionProviderId): Promise<void> {
  resetAttempt();
  authProviderId.value = providerId;
  expandedItemId.value = providerId;
  connectPending.value = true;
  authError.value = "";
  try {
    const result = await store.startProviderAuth(providerId);
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

async function completeSubscriptionAuth(): Promise<void> {
  if (!authAttemptId.value || !authInput.value.trim()) {
    return;
  }

  completePending.value = true;
  authError.value = "";
  try {
    await store.completeProviderAuth(authAttemptId.value, authInput.value.trim());
    resetAttempt();
    expandedItemId.value = undefined;
  } catch (error) {
    authError.value = error instanceof Error ? error.message : String(error);
  } finally {
    completePending.value = false;
  }
}

watchProviderAuthAttempt(
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
    <SettingsCredential
      v-for="provider in providerOrder"
      :key="provider.id"
      :title="itemTitle(provider.id)"
      :status="itemStatusLabel(provider.id)"
      :connected="itemConnected(provider.id)"
      :expanded="isExpanded(provider.id)"
      :disabled="
        isSubscriptionProvider(provider.id)
          ? connectPending || completePending
          : apiKeySaving[provider.id]
      "
      @toggle="toggleExpanded(provider.id)"
    >
      <template v-if="isSubscriptionProvider(provider.id)">
        <div class="settings-popover__help">
          Sign in with your subscription to use <code>{{ provider.id }}/*</code> models.
        </div>
        <div v-if="provider.id === 'openai'" class="settings-popover__help">
          Work subscriptions may require organization approval. Codex (legacy) uses a separate
          sign-in flow.
        </div>
        <div v-if="provider.id === 'openai-codex'" class="settings-popover__help">
          Uses Codex subscription access, subject to your workspace’s Codex permissions.
        </div>
        <div v-if="provider.id === 'anthropic'" class="settings-popover__help">
          Pi supports this login, but Anthropic does not permit Claude subscription login in
          third-party apps.
          <a
            href="https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use"
            target="_blank"
            rel="noopener noreferrer"
            >Anthropic policy</a
          >
        </div>
        <button
          class="settings-popover__action"
          type="button"
          :disabled="connectPending || completePending"
          @click="startSubscriptionAuth(provider.id)"
        >
          <LogIn :size="16" />
          {{
            connectPending
              ? "Starting…"
              : hasAuthAttempt && authProviderId === provider.id
                ? "Restart connect flow"
                : provider.connected
                  ? "Reconnect account"
                  : SUBSCRIPTION_PROVIDERS[provider.id].connectLabel
          }}
        </button>
        <div
          v-if="hasAuthAttempt && authProviderId === provider.id"
          class="settings-popover__attempt"
        >
          <div v-if="authInstructions" class="settings-popover__help">
            {{ authInstructions }}
          </div>
          <div v-if="provider.id !== 'anthropic'" class="settings-popover__help">
            Finish sign-in in your browser. If this stays open, paste the full callback URL from the
            address bar, even if the page cannot load.
          </div>
          <div v-if="authExpiryLabel" class="settings-popover__help">
            Expires: {{ authExpiryLabel }}
          </div>
          <a
            class="settings-popover__action"
            :href="authUrl"
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink :size="14" /> Open sign-in page
          </a>
          <form class="settings-popover__editor" @submit.prevent="completeSubscriptionAuth">
            <SettingsField
              :label="provider.id === 'anthropic' ? 'Authorization code' : 'Callback URL'"
            >
              <textarea
                v-model="authInput"
                class="settings-popover__input settings-popover__textarea"
                rows="4"
                :placeholder="
                  provider.id === 'anthropic'
                    ? 'Paste the code Anthropic shows (code#state)'
                    : 'Paste the full callback URL'
                "
                :disabled="completePending"
              />
            </SettingsField>
            <button
              class="settings-popover__action settings-popover__action--primary"
              type="submit"
              :disabled="completePending || !authInput.trim()"
            >
              <Check :size="16" /> {{ completePending ? "Completing…" : "Complete connection" }}
            </button>
          </form>
        </div>
        <div
          v-if="authError && authProviderId === provider.id"
          class="settings-popover__error"
          role="alert"
        >
          {{ authError }}
        </div>
      </template>

      <form
        v-else
        class="settings-popover__editor"
        @submit.prevent="saveApiKey(provider.id as 'google' | 'openrouter')"
      >
        <SettingsField label="API key">
          <input
            v-model="apiKeyInputs[provider.id as 'google' | 'openrouter']"
            class="settings-popover__input"
            type="text"
            autocomplete="off"
            :placeholder="apiKeyPlaceholder(provider.id as 'google' | 'openrouter')"
            :disabled="apiKeySaving[provider.id]"
          />
          <template #action>
            <button
              class="settings-popover__action settings-popover__action--primary"
              type="submit"
              :disabled="apiKeySaving[provider.id]"
            >
              <Save :size="14" /> {{ apiKeySaving[provider.id] ? "Saving…" : "Save" }}
            </button>
          </template>
        </SettingsField>
        <div v-if="apiKeyErrors[provider.id]" class="settings-popover__error" role="alert">
          {{ apiKeyErrors[provider.id] }}
        </div>
      </form>
    </SettingsCredential>

    <SettingsCredential
      :title="itemTitle(BRAVE_SEARCH_ITEM_ID)"
      :status="itemStatusLabel(BRAVE_SEARCH_ITEM_ID)"
      :connected="itemConnected(BRAVE_SEARCH_ITEM_ID)"
      :expanded="isExpanded(BRAVE_SEARCH_ITEM_ID)"
      :disabled="braveSearchSaving"
      @toggle="toggleExpanded(BRAVE_SEARCH_ITEM_ID)"
    >
      <form class="settings-popover__editor" @submit.prevent="saveBraveSearchKey">
        <SettingsField label="API key">
          <input
            v-model="braveSearchInput"
            class="settings-popover__input"
            type="text"
            autocomplete="off"
            placeholder="Paste Brave Search API key"
            :disabled="braveSearchSaving"
          />
          <template #action>
            <button
              class="settings-popover__action settings-popover__action--primary"
              type="submit"
              :disabled="braveSearchSaving"
            >
              <Save :size="14" /> {{ braveSearchSaving ? "Saving…" : "Save" }}
            </button>
          </template>
        </SettingsField>
        <div v-if="braveSearchError" class="settings-popover__error" role="alert">
          {{ braveSearchError }}
        </div>
      </form>
    </SettingsCredential>
  </section>
</template>
