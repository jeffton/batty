<script setup lang="ts">
import { Copy, Plus, RefreshCw } from "@lucide/vue";
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
import type { RemoteConnection, RemoteGrant } from "@/shared/remotes";

const props = defineProps<{ open: boolean }>();
const connections = ref<RemoteConnection[]>([]);
const grants = ref<RemoteGrant[]>([]);
const connectionUrl = ref("");
const connectionToken = ref("");
const issued = ref<{ id: string; token: string }>();
const copied = ref(false);
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
  copied.value = false;
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

async function copyToken(): Promise<void> {
  const startedIn = opening;
  error.value = "";
  try {
    await navigator.clipboard.writeText(issued.value!.token);
    if (props.open && startedIn === opening) copied.value = true;
  } catch (cause) {
    if (props.open && startedIn === opening) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
  }
}

function clearSecrets(): void {
  connectionToken.value = "";
  issued.value = undefined;
  copied.value = false;
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
  <section class="settings-popover__section" aria-label="Remote Batty">
    <div v-if="error" class="settings-popover__error" role="alert">{{ error }}</div>
    <div v-if="pending" class="settings-popover__help" role="status">Working…</div>
    <div class="settings-popover__editor">
      <button
        class="settings-popover__action settings-popover__action--primary"
        type="button"
        :disabled="pending"
        @click="issueGrant"
      >
        <Plus :size="14" /> Generate token
      </button>
      <div class="settings-popover__help">
        Generate a single-use token here, then add this Batty on the other machine.
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
        </SettingsField>
        <div class="settings-popover__help">Shown until you leave this tab.</div>
        <button class="settings-popover__action" type="button" @click="copyToken">
          <Copy :size="14" /> {{ copied ? "Copied" : "Copy token" }}
        </button>
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
    </div>
    <form class="settings-popover__editor" autocomplete="off" @submit.prevent="addConnection">
      <SettingsField label="Remote URL">
        <input
          v-model="connectionUrl"
          name="pairing-url"
          class="settings-popover__input"
          type="url"
          required
          autocapitalize="none"
          autocomplete="off"
          spellcheck="false"
          :disabled="pending"
        />
      </SettingsField>
      <SettingsField label="Remote token">
        <input
          v-model="connectionToken"
          name="pairing-token"
          class="settings-popover__input"
          type="text"
          required
          autocomplete="one-time-code"
          autocapitalize="none"
          spellcheck="false"
          :disabled="pending"
        />
      </SettingsField>
      <button
        class="settings-popover__action settings-popover__action--primary"
        type="submit"
        :disabled="pending"
      >
        <Plus :size="14" /> Add
      </button>
    </form>
    <div class="settings-popover__editor">
      <div class="settings-popover__item-top">
        <h2 class="settings-popover__group-title">Connections</h2>
        <button
          class="settings-popover__action"
          type="button"
          :disabled="pending"
          @click="perform(load)"
        >
          <RefreshCw :size="14" /> Refresh
        </button>
      </div>
      <div
        v-for="connection in connections"
        :key="connection.id"
        class="settings-popover__item-top"
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
    </div>
  </section>
</template>
