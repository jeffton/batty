<script setup lang="ts">
import { Copy, Plus, RefreshCw } from "@lucide/vue";
import { ref, watch } from "vue";
import DeleteButton from "../DeleteButton.vue";
import SettingsField from "./SettingsField.vue";
import {
  addRemoteConnection,
  getRemoteSettings,
  issueRemoteGrant,
  removeRemoteConnection,
  revokeRemoteGrant,
  setRemoteReverseDial,
} from "@/client/lib/api";
import type { RemoteConnection, RemoteGrant } from "@/shared/remotes";

const props = defineProps<{ open: boolean }>();
const installationId = ref("");
const connectionTransport = ref<"direct" | "reverse">("direct");
const connectionInstanceId = ref("");
const connectionReverseGrantId = ref("");
const connectionReverseDial = ref(false);
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
  const startedIn = opening;
  const settings = await getRemoteSettings();
  if (!props.open || startedIn !== opening) return;
  installationId.value = settings.instanceId;
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
      ...(connectionTransport.value === "reverse"
        ? {
            transport: "reverse" as const,
            instanceId: connectionInstanceId.value.trim(),
            reverseGrantId: connectionReverseGrantId.value,
          }
        : connectionReverseDial.value
          ? { reverseDial: true }
          : {}),
    });
    connectionLabel.value = "";
    connectionUrl.value = "";
    connectionToken.value = "";
    connectionInstanceId.value = "";
    connectionReverseGrantId.value = "";
    connectionReverseDial.value = false;
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

async function setReverseDial(connection: RemoteConnection, event: Event): Promise<void> {
  const checkbox = event.target as HTMLInputElement;
  const enabled = checkbox.checked;
  checkbox.checked = connection.reverseDial ?? false;
  await perform(async () => {
    await setRemoteReverseDial(connection.id, enabled);
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
    <SettingsField label="This installation ID">
      <input class="settings-popover__input" :value="installationId" readonly />
    </SettingsField>
    <div v-if="error" class="settings-popover__error" role="alert">{{ error }}</div>
    <div v-if="pending" class="settings-popover__help" role="status">Working…</div>
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
          <label v-if="connection.transport !== 'reverse'" class="settings-popover__help">
            <input
              type="checkbox"
              :checked="connection.reverseDial ?? false"
              :disabled="pending"
              @change="setReverseDial(connection, $event)"
            />
            Keep reverse connection open
          </label>
          <div
            v-if="connection.transport === 'reverse' || connection.reverseDial"
            class="settings-popover__help"
          >
            {{ connection.transport === "reverse" ? "Via incoming connection" : "Reverse channel" }}
            ·
            {{ connection.status?.state ?? "disconnected" }}
            <span v-if="connection.status?.error">: {{ connection.status.error }}</span>
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
    <form class="settings-popover__editor" @submit.prevent="addConnection">
      <SettingsField label="Connection name">
        <input
          v-model="connectionLabel"
          class="settings-popover__input"
          required
          :disabled="pending"
        />
      </SettingsField>
      <SettingsField label="Transport">
        <select v-model="connectionTransport" class="settings-popover__input" :disabled="pending">
          <option value="direct">Direct HTTPS</option>
          <option value="reverse">Via incoming connection</option>
        </select>
      </SettingsField>
      <template v-if="connectionTransport === 'reverse'">
        <SettingsField label="Remote installation ID">
          <input
            v-model="connectionInstanceId"
            class="settings-popover__input"
            required
            :disabled="pending"
          />
        </SettingsField>
        <SettingsField label="Incoming access token">
          <select
            v-model="connectionReverseGrantId"
            class="settings-popover__input"
            required
            :disabled="pending"
          >
            <option disabled value="">Select the token given to this remote</option>
            <option v-for="grant in grants" :key="grant.id" :value="grant.id">
              {{ grant.label }}
            </option>
          </select>
        </SettingsField>
        <div class="settings-popover__help">
          This token binds the incoming channel to this remote installation.
        </div>
      </template>
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
      <div v-if="connectionTransport === 'reverse'" class="settings-popover__help">
        Used as the file origin; not contacted directly. The remote must open the channel.
      </div>
      <label v-else class="settings-popover__help">
        <input v-model="connectionReverseDial" type="checkbox" :disabled="pending" />
        Keep reverse connection open
      </label>
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
