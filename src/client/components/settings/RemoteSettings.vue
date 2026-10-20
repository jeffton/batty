<script setup lang="ts">
import { Copy, Plus } from "@lucide/vue";
import { ref, watch } from "vue";
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
const connectionLabel = ref("");
const connectionUrl = ref("");
const connectionToken = ref("");
const grantLabel = ref("");
const issued = ref<{ id: string; token: string }>();
const copied = ref(false);
const pending = ref(false);
const error = ref("");
let opening = 0;

async function load(): Promise<void> {
  const settings = await getRemoteSettings();
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
      id: crypto.randomUUID(),
      label: connectionLabel.value.trim(),
      url: connectionUrl.value.trim(),
      token: connectionToken.value.trim(),
    });
    connectionLabel.value = "";
    connectionUrl.value = "";
    connectionToken.value = "";
    await load();
  });
}

async function issueGrant(): Promise<void> {
  const startedIn = opening;
  issued.value = undefined;
  copied.value = false;
  await perform(async () => {
    const result = await issueRemoteGrant(grantLabel.value.trim());
    // A response arriving after the settings were closed must not redisplay the secret.
    if (props.open && startedIn === opening) issued.value = result;
    grantLabel.value = "";
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
  error.value = "";
  try {
    await navigator.clipboard.writeText(issued.value!.token);
    copied.value = true;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}

watch(
  () => props.open,
  (open) => {
    opening++;
    if (open) {
      void perform(load);
    } else {
      connectionToken.value = "";
      issued.value = undefined;
      copied.value = false;
    }
  },
  { immediate: true },
);
</script>

<template>
  <section class="settings-popover__section" aria-label="Remote Batty">
    <div v-if="error" class="settings-popover__error" role="alert">{{ error }}</div>
    <div v-if="pending" class="settings-popover__help" role="status">Working…</div>
    <div class="settings-popover__editor">
      <h2 class="settings-popover__group-title">Connections</h2>
      <p class="settings-popover__help">
        Run workers on another Batty using its models, tools and workspaces.
      </p>
      <div
        v-for="connection in connections"
        :key="connection.id"
        class="settings-popover__item-top"
      >
        <div class="settings-popover__item-meta">
          <div class="settings-popover__group-title">{{ connection.label }}</div>
          <div class="settings-popover__help">{{ connection.id }} · {{ connection.url }}</div>
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
    <form class="settings-popover__editor" @submit.prevent="addConnection">
      <SettingsField label="Connection name">
        <input
          v-model="connectionLabel"
          class="settings-popover__input"
          required
          :disabled="pending"
        />
      </SettingsField>
      <SettingsField label="Remote URL">
        <input
          v-model="connectionUrl"
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
          class="settings-popover__input"
          type="password"
          required
          autocomplete="off"
          :disabled="pending"
        />
      </SettingsField>
      <div class="settings-popover__help">
        Create a token under Settings → Remote → Incoming access on the receiving Batty.
      </div>
      <button
        class="settings-popover__action settings-popover__action--primary"
        type="submit"
        :disabled="pending"
      >
        <Plus :size="14" /> Add connection
      </button>
      <div class="settings-popover__help">
        Removing a connection does not revoke its remote token.
      </div>
    </form>
  </section>
  <section class="settings-popover__section" aria-label="Incoming access">
    <h2 class="settings-popover__group-title">Incoming access</h2>
    <div class="settings-popover__help">
      Allow another Batty to start and control workers here. Create a separate token for each
      connection.
    </div>
    <div v-for="grant in grants" :key="grant.id" class="settings-popover__item-top">
      <div class="settings-popover__item-meta">
        <div class="settings-popover__group-title">{{ grant.label }}</div>
        <div class="settings-popover__help">{{ grant.id }}</div>
      </div>
      <DeleteButton
        class="settings-popover__action"
        :label="`Revoke access ${grant.label}`"
        :disabled="pending"
        @confirm="revokeGrant(grant.id)"
      />
    </div>
    <div v-if="!grants.length && !pending" class="settings-popover__help">No incoming access.</div>
    <form class="settings-popover__editor" @submit.prevent="issueGrant">
      <SettingsField label="Grant name">
        <input v-model="grantLabel" class="settings-popover__input" required :disabled="pending" />
        <template #action>
          <button
            class="settings-popover__action settings-popover__action--primary"
            type="submit"
            :disabled="pending"
          >
            <Plus :size="14" /> Create token
          </button>
        </template>
      </SettingsField>
    </form>
    <div v-if="issued" class="settings-popover__editor">
      <SettingsField label="New token">
        <textarea
          class="settings-popover__input settings-popover__textarea"
          :value="issued.token"
          readonly
          rows="2"
          autocomplete="off"
          spellcheck="false"
        />
      </SettingsField>
      <div class="settings-popover__help">
        Copy this token to the other Batty. It is shown only until you leave this tab.
      </div>
      <button class="settings-popover__action" type="button" @click="copyToken">
        <Copy :size="14" /> {{ copied ? "Copied" : "Copy token" }}
      </button>
    </div>
  </section>
</template>
