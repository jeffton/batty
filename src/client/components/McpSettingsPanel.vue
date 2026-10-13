<script setup lang="ts">
import { Pencil, Plus, RotateCw, LogIn, LogOut, X } from "@lucide/vue";
import DeleteButton from "@/client/components/DeleteButton.vue";
import McpServerEditor from "@/client/components/McpServerEditor.vue";
import { computed, onBeforeUnmount, ref, useId, watch } from "vue";
import FullPopover from "@/client/components/FullPopover.vue";
import {
  cancelMcpAuthAttempt,
  completeMcpAuthAttempt,
  getMcpAuthAttempt,
  getMcpSettings,
  getMcpStatus,
  logoutMcpServer,
  reconnectMcpServer,
  removeMcpServer,
  saveMcpServer,
  startMcpLogin,
} from "@/client/lib/api";
import type {
  McpAuthAttempt,
  McpServerConfig,
  McpSettingsResponse,
  McpStatus,
} from "@/shared/types";

const props = defineProps<{ active: boolean }>();
type Server = McpSettingsResponse["servers"][number];
const settings = ref<McpSettingsResponse>({ servers: [], errors: [] });
const status = ref<McpStatus>({ servers: [], errors: [] });
const toolsPopoverIdPrefix = useId();

function toolsPopoverId(server: Server): string {
  return `${toolsPopoverIdPrefix}-tools-${encodeURIComponent(server.name)}`;
}

const loading = ref(false);
const saving = ref(false);
const error = ref("");
const selectedName = ref("");
const editorOpen = ref(false);
const nameInput = ref("");
const configInput = ref('{\n  "type": "stdio",\n  "command": "",\n  "args": []\n}');
const callbackInput = ref("");
const attempt = ref<McpAuthAttempt>();
const statusBusy = ref("");
let loadGeneration = 0;
let lifecycleGeneration = 0;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;

const visibleServers = computed(() =>
  [...settings.value.servers].sort((a, b) => a.name.localeCompare(b.name)),
);
const attemptServer = computed(() => attempt.value?.serverName);

function serverStatus(server: Server): McpStatus["servers"][number] | undefined {
  return status.value.servers.find((item) => item.name === server.name);
}

function isEditing(server: Server): boolean {
  return editorOpen.value && selectedName.value === server.name;
}

function connectionLabel(server: Server): string {
  if (server.config.enabled === false) return "Disabled";
  const state = serverStatus(server)?.state;
  if (!state) return "Not connected";
  if (state === "needs-auth") return "Sign-in required";
  return state.charAt(0).toUpperCase() + state.slice(1);
}

function connectionActions(server: Server): Array<"reconnect" | "login" | "logout"> {
  if (server.config.enabled === false) return [];
  const status = serverStatus(server);
  if (!status) return [];
  const actions: Array<"reconnect" | "login" | "logout"> = [];
  if (["connected", "disconnected", "failed", "needs-auth"].includes(status.state))
    actions.push("reconnect");
  if (status.usesOAuth && status.state === "needs-auth") actions.push("login");
  if (
    status.usesOAuth &&
    status.hasOAuthCredentials &&
    !["disabled", "connecting", "closed"].includes(status.state)
  )
    actions.push("logout");
  return actions;
}

function invalidateStatus(): void {
  status.value = { servers: [], errors: [] };
}

async function refreshAfterAuth(): Promise<void> {
  clearAttempt();
  await load();
}

function stopPolling(): void {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = undefined;
}

function clearAttempt(): void {
  stopPolling();
  attempt.value = undefined;
  callbackInput.value = "";
}

async function load(): Promise<void> {
  const requestGeneration = ++loadGeneration;
  const lifecycleAtStart = lifecycleGeneration;
  loading.value = true;
  error.value = "";
  try {
    const [nextSettings, nextStatus] = await Promise.all([getMcpSettings(), getMcpStatus()]);
    if (
      disposed ||
      requestGeneration !== loadGeneration ||
      lifecycleAtStart !== lifecycleGeneration
    )
      return;
    settings.value = nextSettings;
    status.value = nextStatus;
  } catch (cause) {
    if (
      !disposed &&
      requestGeneration === loadGeneration &&
      lifecycleAtStart === lifecycleGeneration
    )
      error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (
      !disposed &&
      requestGeneration === loadGeneration &&
      lifecycleAtStart === lifecycleGeneration
    )
      loading.value = false;
  }
}

function beginAdd(): void {
  selectedName.value = "";
  nameInput.value = "";
  configInput.value = '{\n  "type": "stdio",\n  "command": "",\n  "args": []\n}';
}

function editServer(server: Server): void {
  selectedName.value = server.name;
  editorOpen.value = true;
  nameInput.value = server.name;
  const { exposure: _exposure, ...config } = server.config;
  configInput.value = JSON.stringify(config, null, 2);
}

function cancelEdit(): void {
  selectedName.value = "";
  editorOpen.value = false;
  beginAdd();
}

async function save(): Promise<void> {
  error.value = "";
  const name = nameInput.value.trim();
  if (!name) {
    error.value = "Enter a server name";
    return;
  }
  if (selectedName.value && name !== selectedName.value) {
    error.value = "Server names cannot be changed while editing";
    return;
  }
  let config: McpServerConfig;
  try {
    config = JSON.parse(configInput.value) as McpServerConfig;
  } catch {
    error.value = "Enter valid JSON configuration";
    return;
  }
  saving.value = true;
  const requestGeneration = lifecycleGeneration;
  try {
    await saveMcpServer(name, { ...config, exposure: "codemode" });
    if (disposed || requestGeneration !== lifecycleGeneration) return;
    invalidateStatus();
    selectedName.value = "";
    editorOpen.value = false;
    beginAdd();
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    saving.value = false;
  }
}

async function toggleEnabled(server: Server): Promise<void> {
  const requestGeneration = lifecycleGeneration;
  error.value = "";
  try {
    await saveMcpServer(server.name, {
      ...server.config,
      enabled: server.config.enabled === false,
    });
    if (disposed || requestGeneration !== lifecycleGeneration) return;
    invalidateStatus();
    await load();
  } catch (cause) {
    if (!disposed && requestGeneration === lifecycleGeneration) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
  }
}

async function remove(server: Server): Promise<void> {
  error.value = "";
  const requestGeneration = lifecycleGeneration;
  try {
    await removeMcpServer(server.name);
    if (disposed || requestGeneration !== lifecycleGeneration) return;
    invalidateStatus();
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}

async function updateStatus(request: () => Promise<McpStatus>): Promise<void> {
  const requestGeneration = lifecycleGeneration;
  statusBusy.value = "Refreshing…";
  error.value = "";
  try {
    const result = await request();
    if (!disposed && requestGeneration === lifecycleGeneration) status.value = result;
  } catch (cause) {
    if (!disposed && requestGeneration === lifecycleGeneration) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
  } finally {
    if (!disposed && requestGeneration === lifecycleGeneration) statusBusy.value = "";
  }
}

async function reconnect(server: Server): Promise<void> {
  await updateStatus(() => reconnectMcpServer(server.name));
}

async function logout(server: Server): Promise<void> {
  await updateStatus(() => logoutMcpServer(server.name));
}

function schedulePoll(attemptId: string, requestGeneration: number): void {
  stopPolling();
  pollTimer = setTimeout(() => void pollAttempt(attemptId, requestGeneration), 1000);
}

async function pollAttempt(attemptId: string, requestGeneration: number): Promise<void> {
  try {
    const result = await getMcpAuthAttempt(attemptId);
    if (
      disposed ||
      requestGeneration !== lifecycleGeneration ||
      attempt.value?.attemptId !== attemptId
    )
      return;
    attempt.value = result;
    if (result.status === "pending") schedulePoll(attemptId, requestGeneration);
    else if (result.status === "completed") await refreshAfterAuth();
  } catch (cause) {
    if (
      !disposed &&
      requestGeneration === lifecycleGeneration &&
      attempt.value?.attemptId === attemptId
    ) {
      attempt.value = {
        ...attempt.value,
        status: "failed",
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }
}

async function login(server: Server): Promise<void> {
  const name = server.name;
  const requestGeneration = lifecycleGeneration;
  error.value = "";
  try {
    const started = await startMcpLogin(name);
    if (disposed || requestGeneration !== lifecycleGeneration) {
      if (started.status === "pending") void cancelMcpAuthAttempt(started.attemptId);
      return;
    }
    attempt.value = started;
    callbackInput.value = "";
    if (started.status === "pending") schedulePoll(started.attemptId, lifecycleGeneration);
    else if (started.status === "completed") await refreshAfterAuth();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}

async function completeLogin(): Promise<void> {
  const active = attempt.value;
  if (!active || !callbackInput.value.trim()) return;
  const requestGeneration = lifecycleGeneration;
  stopPolling();
  try {
    const result = await completeMcpAuthAttempt(active.attemptId, callbackInput.value.trim());
    if (
      disposed ||
      requestGeneration !== lifecycleGeneration ||
      attempt.value?.attemptId !== active.attemptId
    )
      return;
    attempt.value = result;
    if (result.status === "pending") schedulePoll(active.attemptId, requestGeneration);
    if (result.status === "completed") await refreshAfterAuth();
  } catch (cause) {
    if (
      attempt.value?.attemptId === active.attemptId &&
      requestGeneration === lifecycleGeneration
    ) {
      attempt.value = {
        ...attempt.value,
        error: cause instanceof Error ? cause.message : String(cause),
      };
      schedulePoll(active.attemptId, requestGeneration);
    }
  }
}

async function cancelLogin(): Promise<void> {
  const active = attempt.value;
  if (!active) return;
  clearAttempt();
  const requestGeneration = lifecycleGeneration;
  try {
    const result = await cancelMcpAuthAttempt(active.attemptId);
    if (!disposed && requestGeneration === lifecycleGeneration) attempt.value = result;
  } catch (cause) {
    if (!disposed && requestGeneration === lifecycleGeneration) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
  }
}

watch(
  () => props.active,
  (active, wasActive) => {
    invalidateStatus();
    settings.value = { servers: [], errors: [] };
    statusBusy.value = "";
    cancelEdit();
    lifecycleGeneration++;
    const pendingAttempt = attempt.value;
    clearAttempt();
    if (wasActive && pendingAttempt?.status === "pending") {
      void cancelMcpAuthAttempt(pendingAttempt.attemptId);
    }
    if (active) void load();
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  disposed = true;
  lifecycleGeneration++;
  const pendingAttempt = attempt.value;
  clearAttempt();
  if (pendingAttempt?.status === "pending") void cancelMcpAuthAttempt(pendingAttempt.attemptId);
});
</script>

<template>
  <section class="mcp-settings">
    <div class="mcp-settings__help">
      Servers are shared by all workspaces. Tools are available through code mode.
    </div>
    <div v-for="item in settings.errors" :key="item" class="mcp-settings__error">{{ item }}</div>
    <div v-for="item in status.errors" :key="item" class="mcp-settings__error">{{ item }}</div>
    <div v-if="error" class="mcp-settings__error" role="alert">{{ error }}</div>

    <article v-for="server in visibleServers" :key="server.name" class="mcp-settings__server">
      <div class="mcp-settings__server-head">
        <div class="mcp-settings__server-meta">
          <strong>{{ server.name }}</strong>
        </div>
        <div class="mcp-settings__actions">
          <label class="mcp-settings__switch">
            <input
              type="checkbox"
              role="switch"
              :aria-label="`Enabled ${server.name}`"
              :checked="server.config.enabled !== false"
              :disabled="saving || loading"
              @change="toggleEnabled(server)"
            />
            <span class="mcp-settings__switch-track" aria-hidden="true" />
            <span>Enabled</span>
          </label>
          <button
            v-if="serverStatus(server)?.tools.length"
            class="mcp-settings__secondary"
            type="button"
            :popovertarget="toolsPopoverId(server)"
            :aria-label="`Show tools for ${server.name}`"
          >
            Tools ({{ serverStatus(server)?.tools.length }})
          </button>
          <button
            type="button"
            class="mcp-settings__icon-btn"
            :aria-label="isEditing(server) ? `Cancel edit ${server.name}` : `Edit ${server.name}`"
            :title="isEditing(server) ? 'Cancel edit' : 'Edit'"
            :disabled="saving"
            @click="isEditing(server) ? cancelEdit() : editServer(server)"
          >
            <component :is="isEditing(server) ? X : Pencil" :size="14" />
          </button>
          <DeleteButton
            class="mcp-settings__icon-btn mcp-settings__icon-btn--danger"
            :label="`Remove ${server.name}`"
            title="Remove"
            :disabled="saving"
            @confirm="remove(server)"
          />
        </div>
      </div>
      <div class="mcp-settings__status-row">
        <div class="mcp-settings__details">
          <span>{{ connectionLabel(server) }}</span>
        </div>
        <div
          v-if="!isEditing(server) && connectionActions(server).length"
          class="mcp-settings__actions mcp-settings__connection-actions"
        >
          <button
            v-if="connectionActions(server).includes('reconnect')"
            type="button"
            :disabled="Boolean(statusBusy)"
            @click="reconnect(server)"
          >
            <RotateCw :size="13" /> Reconnect
          </button>
          <button
            v-if="connectionActions(server).includes('login')"
            type="button"
            :disabled="Boolean(statusBusy) || attempt?.status === 'pending'"
            @click="login(server)"
          >
            <LogIn :size="13" /> Sign in
          </button>
          <button
            v-if="connectionActions(server).includes('logout')"
            type="button"
            :disabled="Boolean(statusBusy)"
            @click="logout(server)"
          >
            <LogOut :size="13" /> Sign out
          </button>
        </div>
      </div>
      <McpServerEditor
        v-if="isEditing(server)"
        v-model:name="nameInput"
        v-model:config="configInput"
        :editing="true"
        :saving="saving"
        @save="save"
        @cancel="cancelEdit"
      />
      <FullPopover
        v-if="serverStatus(server)?.tools.length"
        :popover-id="toolsPopoverId(server)"
        :title="`${server.name} tools`"
      >
        <div class="mcp-settings__tools-content">
          <ul class="mcp-settings__tools">
            <li v-for="tool in serverStatus(server)?.tools" :key="tool.name">
              <code>{{ tool.name }}</code
              ><span v-if="tool.description"> — {{ tool.description }}</span>
            </li>
          </ul>
        </div>
      </FullPopover>
      <div v-if="serverStatus(server)?.error" class="mcp-settings__error">
        {{ serverStatus(server)?.error }}
      </div>
      <div v-if="attemptServer === server.name" class="mcp-settings__auth">
        <div>{{ attempt?.prompt ?? `Sign in to ${server.name}.` }}</div>
        <a
          v-if="attempt?.authorizationUrl"
          :href="attempt.authorizationUrl"
          target="_blank"
          rel="noopener noreferrer"
          >Open sign-in page</a
        >
        <div v-if="attempt?.status === 'pending'">Waiting for authorization…</div>
        <textarea
          v-model="callbackInput"
          aria-label="MCP OAuth callback URL"
          placeholder="Paste the full callback URL"
          rows="3"
        />
        <div class="mcp-settings__actions">
          <button type="button" :disabled="!callbackInput.trim()" @click="completeLogin">
            Complete sign-in
          </button>
          <button type="button" class="mcp-settings__secondary" @click="cancelLogin">
            Cancel sign-in
          </button>
        </div>
        <div v-if="attempt?.error" class="mcp-settings__error" role="alert">
          {{ attempt.error }}
        </div>
      </div>
    </article>

    <button
      v-if="!editorOpen || selectedName"
      class="mcp-settings__add"
      type="button"
      :disabled="loading || saving"
      @click="
        editorOpen = true;
        beginAdd();
      "
    >
      <Plus :size="14" /> Add server
    </button>
    <McpServerEditor
      v-if="editorOpen && !selectedName"
      v-model:name="nameInput"
      v-model:config="configInput"
      :editing="false"
      :saving="saving"
      @save="save"
      @cancel="cancelEdit"
    />
  </section>
</template>

<style scoped>
.mcp-settings {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}
.mcp-settings__server-head,
.mcp-settings__actions {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
}
.mcp-settings__server-head {
  justify-content: space-between;
  gap: 0.6rem 1rem;
}
.mcp-settings__actions {
  justify-content: flex-start;
}
.mcp-settings__switch {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  margin-right: 0.35rem;
  white-space: nowrap;
  font-size: 0.78rem;
  cursor: pointer;
}
.mcp-settings__switch input {
  position: absolute;
  width: auto;
  opacity: 0;
}
.mcp-settings__switch-track {
  position: relative;
  flex-shrink: 0;
  width: 2rem;
  height: 1.1rem;
  border-radius: 999px;
  background: var(--color-border-strong);
  transition: background 120ms ease;
}
.mcp-settings__switch-track::after {
  position: absolute;
  top: 0.15rem;
  left: 0.15rem;
  width: 0.8rem;
  height: 0.8rem;
  border-radius: 50%;
  background: var(--color-bg-overlay);
  box-shadow: 0 1px 2px color-mix(in srgb, black 30%, transparent);
  content: "";
  transition: transform 120ms ease;
}
.mcp-settings__switch input:checked + .mcp-settings__switch-track {
  background: var(--color-accent);
}
.mcp-settings__switch input:checked + .mcp-settings__switch-track::after {
  transform: translateX(0.9rem);
}
.mcp-settings__switch input:focus-visible + .mcp-settings__switch-track {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}
.mcp-settings__switch input:disabled + .mcp-settings__switch-track {
  opacity: 0.5;
}
.mcp-settings__server {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  padding: 0.85rem 0;
  border-bottom: 1px solid var(--color-border-soft);
}
.mcp-settings__server-meta {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 0;
  font-size: 0.78rem;
  color: var(--color-text-subtle);
}
.mcp-settings__server-meta strong {
  color: var(--color-text-strong);
  font-size: 0.88rem;
}
.mcp-settings__status-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.25rem 0.65rem;
  color: var(--color-text-subtle);
  font-size: 0.78rem;
}
.mcp-settings__details {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}
.mcp-settings__details span + span::before {
  content: "·";
  margin-right: 0.35rem;
}
.mcp-settings__help {
  color: var(--color-text-subtle);
  font-size: 0.78rem;
}
.mcp-settings__error {
  color: var(--color-error);
  font-size: 0.78rem;
}
.mcp-settings__tools-content {
  height: 100%;
  overflow: auto;
  overflow-wrap: anywhere;
  padding: 1rem;
}
.mcp-settings__tools {
  margin: 0;
  padding-left: 1.2rem;
  font-size: 0.76rem;
}
.mcp-settings__auth {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding-top: 0.5rem;
  font-size: 0.82rem;
}
.mcp-settings__auth textarea {
  width: 100%;
  border: 1px solid var(--color-border-soft);
  border-radius: 0.6rem;
  background: var(--color-bg-app);
  color: inherit;
  padding: 0.65rem 0.75rem;
  font: 0.86rem/1.5 var(--font-family-mono);
}
.mcp-settings button,
.mcp-settings :deep(button.mcp-settings__icon-btn) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  border: 0;
  border-radius: 0.45rem;
  background: var(--color-bg-selection);
  color: var(--color-accent-strong);
  padding: 0.45rem 0.65rem;
  font-family: inherit;
  font-size: 0.78rem;
  cursor: pointer;
}
.mcp-settings button.mcp-settings__secondary {
  background: var(--color-bg-elevated);
  color: var(--color-text);
}
.mcp-settings :deep(button.mcp-settings__icon-btn) {
  background: transparent;
  color: var(--color-text-muted);
  padding: 0;
}
.mcp-settings__connection-actions button {
  background: transparent;
  color: var(--color-text-muted);
  padding: 0.35rem 0.45rem;
}
.mcp-settings__connection-actions {
  gap: 0.25rem;
}
.mcp-settings__add {
  align-self: flex-start;
  margin-top: 0.35rem;
}
@media (hover: hover) {
  .mcp-settings button:hover,
  .mcp-settings :deep(button.mcp-settings__icon-btn:hover) {
    background: var(--color-bg-elevated);
  }
  .mcp-settings :deep(button.mcp-settings__icon-btn--danger:hover) {
    background: var(--color-error-soft);
    color: var(--color-error);
  }
}
.mcp-settings button:disabled {
  opacity: 0.55;
  cursor: default;
}
.mcp-settings a {
  width: fit-content;
}
</style>
