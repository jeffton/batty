<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import {
  cancelMcpAuthAttempt,
  completeMcpAuthAttempt,
  getMcpAuthAttempt,
  getMcpSettings,
  getWorkspaceMcpStatus,
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
  McpWorkspaceStatus,
  WorkspaceInfo,
} from "@/shared/types";

const props = defineProps<{
  active: boolean;
  workspaceId?: string;
  workspaces: WorkspaceInfo[];
}>();

const scope = ref<"global" | "workspace">("global");
const settings = ref<McpSettingsResponse>({ servers: [], errors: [] });
const status = ref<McpWorkspaceStatus>({ servers: [], errors: [] });
const loading = ref(false);
const saving = ref(false);
const error = ref("");
const selectedName = ref("");
const nameInput = ref("");
const configInput = ref(
  '{\n  "type": "stdio",\n  "command": "",\n  "args": [],\n  "exposure": "codemode"\n}',
);
const callbackInput = ref("");
const attempt = ref<McpAuthAttempt>();
const statusBusy = ref("");
let loadGeneration = 0;
let workspaceGeneration = 0;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;

const selectedWorkspaceLabel = computed(
  () => props.workspaces.find((workspace) => workspace.id === props.workspaceId)?.label,
);
const visibleServers = computed(() =>
  settings.value.servers.filter((server) => server.scope === scope.value),
);
const attemptServer = computed(() => attempt.value?.serverName);

function statusForServer(name: string): McpWorkspaceStatus["servers"][number] | undefined {
  return status.value.servers.find((server) => server.name === name);
}

function isOverriddenInWorkspace(server: McpSettingsResponse["servers"][number]): boolean {
  return server.scope === "global" && statusForServer(server.name)?.scope === "project";
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
  const workspaceGenerationAtStart = workspaceGeneration;
  const workspaceId = props.workspaceId;
  loading.value = true;
  error.value = "";
  try {
    const [globalSettings, workspaceSettings] = await Promise.all([
      getMcpSettings(),
      workspaceId ? getMcpSettings(workspaceId) : Promise.resolve(undefined),
    ]);
    const nextSettings: McpSettingsResponse = {
      servers: [
        ...globalSettings.servers.map((server) => ({ ...server, scope: "global" as const })),
        ...(workspaceSettings?.servers.map((server) => ({
          ...server,
          scope: "workspace" as const,
        })) ?? []),
      ],
      errors: [...globalSettings.errors, ...(workspaceSettings?.errors ?? [])],
    };
    let nextStatus: McpWorkspaceStatus = { servers: [], errors: [] };
    if (workspaceId) nextStatus = await getWorkspaceMcpStatus(workspaceId);
    if (
      disposed ||
      requestGeneration !== loadGeneration ||
      workspaceGenerationAtStart !== workspaceGeneration ||
      workspaceId !== props.workspaceId
    )
      return;
    settings.value = nextSettings;
    status.value = nextStatus;
  } catch (cause) {
    if (
      !disposed &&
      requestGeneration === loadGeneration &&
      workspaceGenerationAtStart === workspaceGeneration
    ) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
  } finally {
    if (
      !disposed &&
      requestGeneration === loadGeneration &&
      workspaceGenerationAtStart === workspaceGeneration
    )
      loading.value = false;
  }
}

function beginAdd(): void {
  selectedName.value = "";
  nameInput.value = "";
  configInput.value =
    '{\n  "type": "stdio",\n  "command": "",\n  "args": [],\n  "exposure": "codemode"\n}';
}

function editServer(server: McpSettingsResponse["servers"][number]): void {
  selectedName.value = server.name;
  nameInput.value = server.name;
  scope.value = server.scope;
  configInput.value = JSON.stringify(server.config, null, 2);
}

function cancelEdit(): void {
  selectedName.value = "";
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
  if (scope.value === "workspace" && !props.workspaceId) {
    error.value = "Choose a workspace to save workspace-scoped servers";
    return;
  }
  saving.value = true;
  const requestGeneration = workspaceGeneration;
  try {
    await saveMcpServer(name, config, scope.value === "workspace" ? props.workspaceId : undefined);
    if (disposed || requestGeneration !== workspaceGeneration) return;
    selectedName.value = "";
    beginAdd();
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    saving.value = false;
  }
}

async function toggleEnabled(server: McpSettingsResponse["servers"][number]): Promise<void> {
  const requestGeneration = workspaceGeneration;
  error.value = "";
  try {
    await saveMcpServer(
      server.name,
      { ...server.config, enabled: server.config.enabled === false },
      server.scope === "workspace" ? props.workspaceId : undefined,
    );
    if (disposed || requestGeneration !== workspaceGeneration) return;
    await load();
  } catch (cause) {
    if (!disposed && requestGeneration === workspaceGeneration) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
  }
}

async function remove(server: McpSettingsResponse["servers"][number]): Promise<void> {
  if (!window.confirm(`Remove MCP server “${server.name}”?`)) return;
  error.value = "";
  const requestGeneration = workspaceGeneration;
  try {
    await removeMcpServer(
      server.name,
      server.scope === "workspace" ? props.workspaceId : undefined,
    );
    if (disposed || requestGeneration !== workspaceGeneration) return;
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}

async function updateStatus(request: () => Promise<McpWorkspaceStatus>): Promise<void> {
  if (!props.workspaceId) return;
  const requestGeneration = workspaceGeneration;
  statusBusy.value = "Refreshing…";
  error.value = "";
  try {
    const result = await request();
    if (!disposed && requestGeneration === workspaceGeneration) status.value = result;
  } catch (cause) {
    if (!disposed && requestGeneration === workspaceGeneration) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
  } finally {
    if (!disposed && requestGeneration === workspaceGeneration) statusBusy.value = "";
  }
}

async function reconnect(name: string): Promise<void> {
  await updateStatus(() => reconnectMcpServer(props.workspaceId!, name));
}

async function logout(name: string): Promise<void> {
  await updateStatus(() => logoutMcpServer(props.workspaceId!, name));
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
      requestGeneration !== workspaceGeneration ||
      attempt.value?.attemptId !== attemptId
    )
      return;
    attempt.value = result;
    if (result.status === "pending") schedulePoll(attemptId, requestGeneration);
    else if (result.status === "completed") await load();
  } catch (cause) {
    if (
      !disposed &&
      requestGeneration === workspaceGeneration &&
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

async function login(name: string): Promise<void> {
  if (!props.workspaceId) return;
  const workspaceId = props.workspaceId;
  const requestGeneration = workspaceGeneration;
  error.value = "";
  try {
    const started = await startMcpLogin(workspaceId, name);
    if (
      disposed ||
      requestGeneration !== workspaceGeneration ||
      workspaceId !== props.workspaceId
    ) {
      if (started.status === "pending") void cancelMcpAuthAttempt(started.attemptId);
      return;
    }
    attempt.value = started;
    callbackInput.value = "";
    if (started.status === "pending") schedulePoll(started.attemptId, workspaceGeneration);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}

async function completeLogin(): Promise<void> {
  const active = attempt.value;
  if (!active || !callbackInput.value.trim()) return;
  const requestGeneration = workspaceGeneration;
  stopPolling();
  try {
    const result = await completeMcpAuthAttempt(active.attemptId, callbackInput.value.trim());
    if (
      disposed ||
      requestGeneration !== workspaceGeneration ||
      attempt.value?.attemptId !== active.attemptId
    )
      return;
    attempt.value = result;
    if (result.status === "pending") schedulePoll(active.attemptId, requestGeneration);
    if (result.status === "completed") await load();
  } catch (cause) {
    if (
      attempt.value?.attemptId === active.attemptId &&
      requestGeneration === workspaceGeneration
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
  const requestGeneration = workspaceGeneration;
  try {
    const result = await cancelMcpAuthAttempt(active.attemptId);
    if (!disposed && requestGeneration === workspaceGeneration) attempt.value = result;
  } catch (cause) {
    if (!disposed && requestGeneration === workspaceGeneration) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
  }
}

watch(
  () => [props.active, props.workspaceId] as const,
  ([active], previous = [false, undefined]) => {
    const [wasActive] = previous;
    if (!props.workspaceId && scope.value === "workspace") {
      scope.value = "global";
      if (selectedName.value) cancelEdit();
    }
    workspaceGeneration++;
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
  workspaceGeneration++;
  const pendingAttempt = attempt.value;
  clearAttempt();
  if (pendingAttempt?.status === "pending") void cancelMcpAuthAttempt(pendingAttempt.attemptId);
});
</script>

<template>
  <section class="mcp-settings">
    <div class="mcp-settings__toolbar">
      <label class="mcp-settings__scope">
        <span>Scope</span>
        <select v-model="scope" aria-label="MCP server scope">
          <option value="global">Global</option>
          <option value="workspace" :disabled="!props.workspaceId">Workspace</option>
        </select>
      </label>
      <button type="button" :disabled="loading" @click="load">
        {{ loading ? "Loading…" : "Refresh servers" }}
      </button>
    </div>
    <div class="mcp-settings__help">
      <template v-if="props.workspaceId"
        >Workspace: {{ selectedWorkspaceLabel ?? props.workspaceId }}</template
      >
      <template v-else>Choose a workspace to connect, sign in, or inspect server tools.</template>
    </div>

    <div v-for="item in settings.errors" :key="item" class="mcp-settings__error">{{ item }}</div>
    <div v-for="item in status.errors" :key="item" class="mcp-settings__error">{{ item }}</div>
    <div v-if="error" class="mcp-settings__error" role="alert">{{ error }}</div>

    <article
      v-for="server in visibleServers"
      :key="`${server.scope}:${server.name}`"
      class="mcp-settings__server"
    >
      <div class="mcp-settings__server-head">
        <div class="mcp-settings__server-meta">
          <strong>{{ server.name }}</strong>
          <span>{{
            server.scope === "global"
              ? "Global"
              : `Workspace · ${selectedWorkspaceLabel ?? "selected"}`
          }}</span>
          <span v-if="isOverriddenInWorkspace(server)">Overridden in this workspace</span>
          <span v-else>{{
            server.config.enabled === false
              ? "Disabled"
              : (statusForServer(server.name)?.state ?? "Not connected")
          }}</span>
        </div>
        <div class="mcp-settings__actions">
          <button type="button" @click="editServer(server)">Edit</button>
          <button type="button" @click="toggleEnabled(server)">
            {{ server.config.enabled === false ? "Enable" : "Disable" }}
          </button>
          <button type="button" :aria-label="`Remove ${server.name}`" @click="remove(server)">
            Remove
          </button>
        </div>
      </div>
      <div class="mcp-settings__help">Exposure: {{ server.config.exposure ?? "codemode" }}</div>
      <ul v-if="statusForServer(server.name)?.tools.length" class="mcp-settings__tools">
        <li v-for="tool in statusForServer(server.name)?.tools" :key="tool.name">
          <code>{{ tool.name }}</code> · {{ tool.exposure
          }}<span v-if="tool.description"> — {{ tool.description }}</span>
        </li>
      </ul>
      <div v-if="statusForServer(server.name)?.error" class="mcp-settings__error">
        {{ statusForServer(server.name)?.error }}
      </div>
      <div v-if="props.workspaceId" class="mcp-settings__actions">
        <button
          type="button"
          :disabled="Boolean(statusBusy) || isOverriddenInWorkspace(server)"
          @click="reconnect(server.name)"
        >
          Reconnect
        </button>
        <button
          type="button"
          :disabled="Boolean(statusBusy) || isOverriddenInWorkspace(server)"
          @click="login(server.name)"
        >
          Sign in
        </button>
        <button
          type="button"
          :disabled="Boolean(statusBusy) || isOverriddenInWorkspace(server)"
          @click="logout(server.name)"
        >
          Sign out
        </button>
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
          <button type="button" @click="cancelLogin">Cancel sign-in</button>
        </div>
        <div v-if="attempt?.error" class="mcp-settings__error" role="alert">
          {{ attempt.error }}
        </div>
      </div>
    </article>

    <form class="mcp-settings__form" @submit.prevent="save">
      <h4>{{ selectedName ? `Edit ${selectedName}` : "Add server" }}</h4>
      <label>
        <span>Name</span>
        <input
          v-model="nameInput"
          aria-label="MCP server name"
          autocomplete="off"
          :disabled="Boolean(selectedName) || saving"
        />
      </label>
      <label>
        <span>Server configuration (JSON)</span>
        <textarea
          v-model="configInput"
          aria-label="MCP server configuration"
          rows="9"
          spellcheck="false"
          :disabled="saving"
        />
      </label>
      <div class="mcp-settings__actions">
        <button type="submit" :disabled="saving || (scope === 'workspace' && !props.workspaceId)">
          {{ saving ? "Saving…" : "Save server" }}
        </button>
        <button v-if="selectedName" type="button" @click="cancelEdit">Cancel edit</button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.mcp-settings {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}
.mcp-settings__toolbar,
.mcp-settings__server-head,
.mcp-settings__actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.4rem;
  flex-wrap: wrap;
}
.mcp-settings__scope,
.mcp-settings__form label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  flex: 1;
}
.mcp-settings__server {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.55rem 0;
  border-bottom: 1px solid var(--color-border-soft);
}
.mcp-settings__server-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
  font-size: 0.78rem;
  color: var(--color-text-muted);
}
.mcp-settings__server-meta strong {
  color: var(--color-text-strong);
  font-size: 0.84rem;
}
.mcp-settings__help {
  color: var(--color-text-subtle);
  font-size: 0.78rem;
}
.mcp-settings__error {
  color: var(--color-warning);
  font-size: 0.78rem;
}
.mcp-settings__tools {
  margin: 0;
  padding-left: 1.2rem;
  font-size: 0.76rem;
}
.mcp-settings__auth,
.mcp-settings__form {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  padding-top: 0.4rem;
}
.mcp-settings__form h4 {
  margin: 0;
  color: var(--color-text-strong);
}
.mcp-settings input,
.mcp-settings textarea,
.mcp-settings select {
  width: 100%;
  border: 1px solid var(--color-border-soft);
  border-radius: 0.45rem;
  background: var(--color-bg-app);
  color: inherit;
  padding: 0.5rem;
  font: inherit;
  font-family: var(--font-family-mono);
}
.mcp-settings button {
  border: 1px solid var(--color-border-soft);
  border-radius: 0.45rem;
  background: var(--color-bg-panel-strong);
  color: inherit;
  padding: 0.4rem 0.55rem;
  font: inherit;
  font-size: 0.78rem;
  cursor: pointer;
}
.mcp-settings button:disabled {
  opacity: 0.55;
  cursor: default;
}
.mcp-settings a {
  width: fit-content;
}
</style>
