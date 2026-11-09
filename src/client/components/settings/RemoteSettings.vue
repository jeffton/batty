<script setup lang="ts">
import { Check, Copy, Plus, RefreshCw } from "@lucide/vue";
import { onBeforeUnmount, ref, watch } from "vue";
import DeleteButton from "../DeleteButton.vue";
import SettingsField from "./SettingsField.vue";
import {
  addRemoteConnection,
  getRemoteSettings,
  issueRemoteGrant,
  removeRemoteConnection,
  revokeRemoteGrant,
} from "@/client/lib/api";
import { withBaseUrl } from "@/client/lib/base-url";
import type { RemoteConnection, RemoteGrant } from "@/shared/remotes";

const props = defineProps<{ open: boolean }>();
const connections = ref<RemoteConnection[]>([]);
const grants = ref<RemoteGrant[]>([]);
const connectionUrl = ref("");
const connectionToken = ref("");
const issued = ref<{ id: string; token: string }>();
const currentServerUrl = `${window.location.origin}${withBaseUrl("/")}`;
const copiedUrl = ref(false);
const copiedToken = ref(false);
const pending = ref(false);
const error = ref("");
let opening = 0;

async function load(): Promise<void> {
  const startedIn = opening;
  const settings = await getRemoteSettings();
  if (!props.open || startedIn !== opening) return;
  connections.value = settings.connections;
  grants.value = settings.grants;
}

async function perform(action: () => Promise<void>): Promise<void> {
  if (pending.value) return;
  pending.value = true;
  error.value = "";
  try {
    await action();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    pending.value = false;
  }
}

async function addConnection(): Promise<void> {
  await perform(async () => {
    await addRemoteConnection({
      url: connectionUrl.value.trim(),
      token: connectionToken.value.trim(),
    });
    connectionUrl.value = "";
    connectionToken.value = "";
    await load();
  });
}

async function issueGrant(): Promise<void> {
  if (pending.value) return;
  const startedIn = opening;
  issued.value = undefined;
  copiedToken.value = false;
  await perform(async () => {
    const result = await issueRemoteGrant();
    // Closing settings must also discard a secret still in flight.
    if (props.open && startedIn === opening) issued.value = result;
    await load();
  });
}

async function revokeGrant(id: string): Promise<void> {
  await perform(async () => {
    await revokeRemoteGrant(id);
    if (issued.value?.id === id) issued.value = undefined;
    await load();
  });
}

async function removeConnection(id: string): Promise<void> {
  await perform(async () => {
    await removeRemoteConnection(id);
    await load();
  });
}

async function copyValue(value: string, target: "url" | "token"): Promise<void> {
  const startedIn = opening;
  error.value = "";
  try {
    await navigator.clipboard.writeText(value);
    if (props.open && startedIn === opening) {
      if (target === "url") copiedUrl.value = true;
      else copiedToken.value = true;
    }
  } catch (cause) {
    if (props.open && startedIn === opening) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
  }
}

function clearSecrets(): void {
  connectionToken.value = "";
  issued.value = undefined;
  copiedUrl.value = false;
  copiedToken.value = false;
}

watch(
  () => props.open,
  (open) => {
    opening++;
    if (open) {
      void perform(load);
    } else {
      clearSecrets();
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  opening++;
  clearSecrets();
});

function connectionStatus(connection: RemoteConnection): string {
  switch (connection.status?.state) {
    case "connected":
      return "Online";
    case "connecting":
      return "Connecting";
    default:
      return "Offline";
  }
}
</script>

<template>
  <section class="settings-popover__section remote-settings" aria-label="Remote Batty">
    <div v-if="error" class="settings-popover__error" role="alert">{{ error }}</div>
    <div v-if="pending" class="settings-popover__help" role="status">Working…</div>
    <section class="remote-settings__group" aria-label="This Batty">
      <h2 class="settings-popover__group-title">This Batty</h2>
      <div class="remote-settings__address">
        <code class="settings-popover__help">{{ currentServerUrl }}</code>
        <button
          class="settings-popover__action remote-settings__icon"
          type="button"
          aria-label="Copy URL"
          :title="copiedUrl ? 'Copied' : 'Copy URL'"
          @click="copyValue(currentServerUrl, 'url')"
        >
          <Check v-if="copiedUrl" :size="14" />
          <Copy v-else :size="14" />
        </button>
      </div>
      <button
        class="settings-popover__action settings-popover__action--primary"
        type="button"
        :disabled="pending"
        @click="issueGrant"
      >
        <Plus :size="14" /> Generate token
      </button>
      <div v-if="!issued" class="settings-popover__help">
        Single-use token for the other machine.
      </div>
      <div v-if="issued" class="settings-popover__editor">
        <SettingsField label="Generated token">
          <textarea
            class="settings-popover__input settings-popover__textarea"
            :value="issued.token"
            readonly
            rows="2"
            autocomplete="off"
            spellcheck="false"
          />
          <template #action>
            <button
              class="settings-popover__action remote-settings__icon"
              type="button"
              aria-label="Copy token"
              :title="copiedToken ? 'Copied' : 'Copy token'"
              @click="copyValue(issued.token, 'token')"
            >
              <Check v-if="copiedToken" :size="14" />
              <Copy v-else :size="14" />
            </button>
          </template>
        </SettingsField>
        <div class="settings-popover__help">Shown until you leave this tab.</div>
      </div>
      <div v-for="grant in grants" :key="grant.id" class="settings-popover__item-top">
        <div class="settings-popover__help">Unused token</div>
        <DeleteButton
          class="settings-popover__action"
          label="Cancel unused token"
          :disabled="pending"
          @confirm="revokeGrant(grant.id)"
        />
      </div>
    </section>
    <form
      class="remote-settings__group"
      aria-label="Connect to another Batty"
      autocomplete="off"
      @submit.prevent="addConnection"
    >
      <h2 class="settings-popover__group-title">Connect to another Batty</h2>
      <SettingsField label="URL">
        <input
          v-model="connectionUrl"
          name="pairing-url"
          aria-label="Remote URL"
          class="settings-popover__input"
          type="url"
          required
          autocapitalize="none"
          autocomplete="off"
          spellcheck="false"
          :disabled="pending"
        />
      </SettingsField>
      <SettingsField label="Token">
        <input
          v-model="connectionToken"
          name="pairing-token"
          aria-label="Remote token"
          class="settings-popover__input"
          type="text"
          required
          autocomplete="one-time-code"
          autocapitalize="none"
          spellcheck="false"
          :disabled="pending"
        />
        <template #action>
          <button
            class="settings-popover__action settings-popover__action--primary"
            type="submit"
            :disabled="pending"
          >
            <Plus :size="14" /> Add
          </button>
        </template>
      </SettingsField>
    </form>
    <section class="remote-settings__group" aria-label="Connections">
      <div class="settings-popover__item-top">
        <h2 class="settings-popover__group-title">Connections</h2>
        <button
          class="settings-popover__action"
          type="button"
          aria-label="Refresh connections"
          title="Refresh connections"
          :disabled="pending"
          :aria-busy="pending"
          @click="perform(load)"
        >
          <RefreshCw :size="14" />
        </button>
      </div>
      <div
        v-for="connection in connections"
        :key="connection.id"
        class="settings-popover__item-top remote-settings__peer"
      >
        <div class="settings-popover__item-meta">
          <div class="settings-popover__group-title">{{ connection.label }}</div>
          <div v-if="connection.url" class="settings-popover__help">{{ connection.url }}</div>
          <div class="settings-popover__help">{{ connectionStatus(connection) }}</div>
          <div v-if="connection.status?.error" class="settings-popover__error" role="alert">
            {{ connection.status.error }}
          </div>
        </div>
        <DeleteButton
          class="settings-popover__action"
          :label="`Remove connection ${connection.label}`"
          :disabled="pending"
          @confirm="removeConnection(connection.id)"
        />
      </div>
      <div v-if="!connections.length && !pending" class="settings-popover__help">
        No connections.
      </div>
    </section>
    <span class="remote-settings__announcement" role="status" aria-live="polite">
      {{ copiedUrl ? "URL copied." : "" }} {{ copiedToken ? "Token copied." : "" }}
    </span>
  </section>
</template>

<style scoped>
.remote-settings .remote-settings__group {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 0.75rem;
}

.remote-settings__group + .remote-settings__group {
  padding-top: 1.4rem;
  border-top: 1px solid var(--color-border-soft);
}

.remote-settings__address {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-width: 0;
  padding: 0 0.35rem 0 0.8rem;
  border: 1px solid var(--color-border-soft);
  border-radius: 0.55rem;
  background: var(--color-bg-panel-strong);
}

.remote-settings__address code {
  flex: 1;
  min-width: 0;
}

.remote-settings .remote-settings__icon,
.remote-settings [aria-label="Refresh connections"] {
  flex: 0 0 44px;
  width: 44px;
  height: 44px;
  padding: 0;
}

.remote-settings__address .remote-settings__icon,
.remote-settings [aria-label="Refresh connections"] {
  border-color: transparent;
  background: transparent;
}

.remote-settings .remote-settings__peer {
  align-items: flex-start;
}

.remote-settings__peer .settings-popover__group-title {
  overflow-wrap: anywhere;
}

.remote-settings__announcement {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}
</style>
