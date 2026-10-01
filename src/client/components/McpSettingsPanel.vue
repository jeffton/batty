<script setup lang="ts">
import { Save } from "@lucide/vue";
import { computed, onBeforeUnmount, ref, useId, watch } from "vue";
import FullPopover from "@/client/components/FullPopover.vue";
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

type ScopedServer = McpSettingsResponse["servers"][number] & {
  workspaceId?: string;
  workspaceLabel?: string;
};

const settings = ref<{ servers: ScopedServer[]; errors: string[] }>({ servers: [], errors: [] });
const statusByWorkspace = ref<Record<string, McpWorkspaceStatus>>({});
const status = computed(
  () =>
    (props.workspaceId && statusByWorkspace.value[props.workspaceId]) || {
      servers: [],
      errors: [],
    },
);
const toolsPopoverIdPrefix = useId();

function toolsPopoverId(server: ScopedServer): string {
  return `${toolsPopoverIdPrefix}-tools-${encodeURIComponent(JSON.stringify([server.scope, server.workspaceId, server.name]))}`;
}

const loading = ref(false);
const saving = ref(false);
const error = ref("");
const selectedName = ref("");
const editorOpen = ref(false);
const creatingGlobal = ref(true);
const creationWorkspaceId = ref("");
const editWorkspaceId = ref<string | undefined>();
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

const visibleServers = computed(() =>
  [...settings.value.servers].sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === "global" ? -1 : 1;
    return (
      (a.workspaceLabel ?? "").localeCompare(b.workspaceLabel ?? "") || a.name.localeCompare(b.name)
    );
  }),
);
const attemptServer = computed(() => attempt.value?.serverName);
const creationWorkspaceOptions = computed(() => props.workspaces);
const validCreationWorkspace = computed(() =>
  props.workspaces.some((workspace) => workspace.id === creationWorkspaceId.value),
);

function targetWorkspaceId(server: ScopedServer): string | undefined {
  return server.scope === "workspace" ? server.workspaceId : props.workspaceId;
}

function workspaceStatus(server: ScopedServer): McpWorkspaceStatus["servers"][number] | undefined {
  const workspaceId = targetWorkspaceId(server);
  return workspaceId
    ? statusByWorkspace.value[workspaceId]?.servers.find((item) => item.name === server.name)
    : undefined;
}

function statusForServer(name: string): McpWorkspaceStatus["servers"][number] | undefined {
  return status.value.servers.find((server) => server.name === name);
}

function isOverriddenInWorkspace(server: ScopedServer): boolean {
  return (
    server.scope === "global" &&
    (statusForServer(server.name)?.scope === "project" ||
      settings.value.servers.some(
        (item) =>
          item.workspaceId === props.workspaceId &&
          item.scope === "workspace" &&
          item.name === server.name,
      ))
  );
}

function invalidateStatus(workspaceId?: string): void {
  if (workspaceId) delete statusByWorkspace.value[workspaceId];
  else statusByWorkspace.value = {};
}

async function refreshAfterAuth(workspaceId: string, requestGeneration: number): Promise<void> {
  await load();
  if (disposed || requestGeneration !== workspaceGeneration || workspaceId === props.workspaceId)
    return;
  const result = await getWorkspaceMcpStatus(workspaceId);
  if (!disposed && requestGeneration === workspaceGeneration)
    statusByWorkspace.value[workspaceId] = result;
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
  const workspaces = props.workspaces;
  loading.value = true;
  error.value = "";
  try {
    const [globalSettings, ...workspaceSettings] = await Promise.all([
      getMcpSettings(),
      ...workspaces.map((workspace) => getMcpSettings(workspace.id)),
    ]);
    const nextSettings = {
      servers: [
        ...globalSettings.servers.map((server) => ({ ...server, scope: "global" as const })),
        ...workspaceSettings.flatMap((result, index) =>
          result.servers.map((server) => ({
            ...server,
            scope: "workspace" as const,
            workspaceId: workspaces[index].id,
            workspaceLabel: workspaces[index].label,
          })),
        ),
      ],
      errors: [...globalSettings.errors, ...workspaceSettings.flatMap((result) => result.errors)],
    };
    let nextStatus: McpWorkspaceStatus = { servers: [], errors: [] };
    if (workspaceId) nextStatus = await getWorkspaceMcpStatus(workspaceId);
    if (
      disposed ||
      requestGeneration !== loadGeneration ||
      workspaceGenerationAtStart !== workspaceGeneration ||
      workspaceId !== props.workspaceId ||
      workspaces.map((workspace) => `${workspace.id}:${workspace.label}`).join("|") !==
        props.workspaces.map((workspace) => `${workspace.id}:${workspace.label}`).join("|")
    )
      return;
    settings.value = nextSettings;
    if (workspaceId) statusByWorkspace.value[workspaceId] = nextStatus;
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
  editWorkspaceId.value = undefined;
  creatingGlobal.value = true;
  creationWorkspaceId.value = props.workspaceId ?? creationWorkspaceOptions.value[0]?.id ?? "";
  nameInput.value = "";
  configInput.value =
    '{\n  "type": "stdio",\n  "command": "",\n  "args": [],\n  "exposure": "codemode"\n}';
}

function editServer(server: ScopedServer): void {
  selectedName.value = server.name;
  editWorkspaceId.value = server.workspaceId;
  editorOpen.value = true;
  nameInput.value = server.name;
  configInput.value = JSON.stringify(server.config, null, 2);
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
  if (!selectedName.value && !creatingGlobal.value && !validCreationWorkspace.value) {
    error.value = "Choose a workspace to save workspace-scoped servers";
    return;
  }
  saving.value = true;
  const requestGeneration = workspaceGeneration;
  try {
    const workspaceId = selectedName.value
      ? editWorkspaceId.value
      : creatingGlobal.value
        ? undefined
        : creationWorkspaceId.value;
    await saveMcpServer(name, config, workspaceId);
    if (disposed || requestGeneration !== workspaceGeneration) return;
    invalidateStatus(workspaceId);
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

async function toggleEnabled(server: ScopedServer): Promise<void> {
  const requestGeneration = workspaceGeneration;
  error.value = "";
  try {
    await saveMcpServer(
      server.name,
      { ...server.config, enabled: server.config.enabled === false },
      server.workspaceId,
    );
    if (disposed || requestGeneration !== workspaceGeneration) return;
    invalidateStatus(server.workspaceId);
    await load();
  } catch (cause) {
    if (!disposed && requestGeneration === workspaceGeneration) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
  }
}

async function remove(server: ScopedServer): Promise<void> {
  if (!window.confirm(`Remove MCP server “${server.name}”?`)) return;
  error.value = "";
  const requestGeneration = workspaceGeneration;
  try {
    await removeMcpServer(server.name, server.workspaceId);
    if (disposed || requestGeneration !== workspaceGeneration) return;
    invalidateStatus(server.workspaceId);
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}

async function updateStatus(
  workspaceId: string,
  request: () => Promise<McpWorkspaceStatus>,
): Promise<void> {
  const requestGeneration = workspaceGeneration;
  statusBusy.value = "Refreshing…";
  error.value = "";
  try {
    const result = await request();
    if (!disposed && requestGeneration === workspaceGeneration)
      statusByWorkspace.value[workspaceId] = result;
  } catch (cause) {
    if (!disposed && requestGeneration === workspaceGeneration) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
  } finally {
    if (!disposed && requestGeneration === workspaceGeneration) statusBusy.value = "";
  }
}

async function reconnect(server: ScopedServer): Promise<void> {
  const workspaceId = targetWorkspaceId(server);
  if (workspaceId)
    await updateStatus(workspaceId, () => reconnectMcpServer(workspaceId, server.name));
}

async function logout(server: ScopedServer): Promise<void> {
  const workspaceId = targetWorkspaceId(server);
  if (workspaceId) await updateStatus(workspaceId, () => logoutMcpServer(workspaceId, server.name));
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
    else if (result.status === "completed")
      await refreshAfterAuth(result.workspaceId, requestGeneration);
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

async function login(server: ScopedServer): Promise<void> {
  const workspaceId = targetWorkspaceId(server);
  if (!workspaceId) return;
  const name = server.name;
  const requestGeneration = workspaceGeneration;
  error.value = "";
  try {
    const started = await startMcpLogin(workspaceId, name);
    if (disposed || requestGeneration !== workspaceGeneration) {
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
    if (result.status === "completed")
      await refreshAfterAuth(result.workspaceId, requestGeneration);
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
  () =>
    [
      props.active,
      props.workspaceId,
      props.workspaces.map((workspace) => `${workspace.id}:${workspace.label}`).join("|"),
    ] as const,
  ([active], previous = [false, undefined]) => {
    const [wasActive] = previous;
    if (!validCreationWorkspace.value) creationWorkspaceId.value = "";
    for (const workspaceId of Object.keys(statusByWorkspace.value)) {
      if (!props.workspaces.some((workspace) => workspace.id === workspaceId))
        delete statusByWorkspace.value[workspaceId];
    }
    if (
      selectedName.value &&
      editWorkspaceId.value &&
      !props.workspaces.some((workspace) => workspace.id === editWorkspaceId.value)
    )
      cancelEdit();
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
    <div class="mcp-settings__help">
      MCP servers are listed by scope. Workspace servers apply only to their named workspace.
    </div>
    <div v-for="item in settings.errors" :key="item" class="mcp-settings__error">{{ item }}</div>
    <div v-for="item in status.errors" :key="item" class="mcp-settings__error">{{ item }}</div>
    <div v-if="error" class="mcp-settings__error" role="alert">{{ error }}</div>

    <article
      v-for="server in visibleServers"
      :key="`${server.scope}:${server.workspaceId ?? 'global'}:${server.name}`"
      class="mcp-settings__server"
    >
      <div class="mcp-settings__server-head">
        <div class="mcp-settings__server-meta">
          <strong>{{ server.name }}</strong>
          <span>{{
            server.scope === "global" ? "Global" : `Workspace · ${server.workspaceLabel}`
          }}</span>
          <span v-if="isOverriddenInWorkspace(server)">Overridden in this workspace</span>
          <span v-else>{{
            server.config.enabled === false
              ? "Disabled"
              : (workspaceStatus(server)?.state ??
                (statusByWorkspace[targetWorkspaceId(server) ?? ""]
                  ? "Not connected"
                  : "Not inspected"))
          }}</span>
        </div>
        <div class="mcp-settings__actions">
          <button type="button" @click="editServer(server)">Edit</button>
          <button
            v-if="workspaceStatus(server)?.tools.length"
            type="button"
            :popovertarget="toolsPopoverId(server)"
            :aria-label="`Show tools for ${server.name}`"
          >
            Tools ({{ workspaceStatus(server)?.tools.length }})
          </button>
          <button type="button" @click="toggleEnabled(server)">
            {{ server.config.enabled === false ? "Enable" : "Disable" }}
          </button>
          <button type="button" :aria-label="`Remove ${server.name}`" @click="remove(server)">
            Remove
          </button>
        </div>
      </div>
      <div class="mcp-settings__help">Exposure: {{ server.config.exposure ?? "codemode" }}</div>
      <FullPopover
        v-if="workspaceStatus(server)?.tools.length"
        :popover-id="toolsPopoverId(server)"
        :title="`${server.name} tools`"
        :subtitle="server.scope === 'global' ? 'Global' : `Workspace · ${server.workspaceLabel}`"
      >
        <div class="mcp-settings__tools-content">
          <ul class="mcp-settings__tools">
            <li v-for="tool in workspaceStatus(server)?.tools" :key="tool.name">
              <code>{{ tool.name }}</code> · {{ tool.exposure
              }}<span v-if="tool.description"> — {{ tool.description }}</span>
            </li>
          </ul>
        </div>
      </FullPopover>
      <div v-if="workspaceStatus(server)?.error" class="mcp-settings__error">
        {{ workspaceStatus(server)?.error }}
      </div>
      <template v-if="targetWorkspaceId(server) !== props.workspaceId">
        <div
          v-for="item in statusByWorkspace[targetWorkspaceId(server) ?? '']?.errors"
          :key="item"
          class="mcp-settings__error"
        >
          {{ item }}
        </div>
      </template>
      <div v-if="targetWorkspaceId(server)" class="mcp-settings__actions">
        <button
          type="button"
          :disabled="Boolean(statusBusy) || isOverriddenInWorkspace(server)"
          @click="reconnect(server)"
        >
          Reconnect
        </button>
        <button
          type="button"
          :disabled="Boolean(statusBusy) || isOverriddenInWorkspace(server)"
          @click="login(server)"
        >
          Sign in
        </button>
        <button
          type="button"
          :disabled="Boolean(statusBusy) || isOverriddenInWorkspace(server)"
          @click="logout(server)"
        >
          Sign out
        </button>
      </div>
      <div
        v-if="
          !isOverriddenInWorkspace(server) &&
          attemptServer === server.name &&
          attempt?.workspaceId === targetWorkspaceId(server) &&
          targetWorkspaceId(server)
        "
        class="mcp-settings__auth"
      >
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

    <button
      v-if="!editorOpen"
      type="button"
      :disabled="loading"
      @click="
        editorOpen = true;
        beginAdd();
      "
    >
      Add server
    </button>
    <form v-if="editorOpen" class="mcp-settings__form" @submit.prevent="save">
      <h4>{{ selectedName ? `Edit ${selectedName}` : "Add server" }}</h4>
      <div v-if="!selectedName" class="mcp-settings__scope-row">
        <label class="mcp-settings__switch">
          <input
            v-model="creatingGlobal"
            type="checkbox"
            role="switch"
            aria-label="Global server"
          />
          <span class="mcp-settings__switch-track" aria-hidden="true" />
          <span>Global server</span>
        </label>
        <select
          v-if="!creatingGlobal"
          v-model="creationWorkspaceId"
          class="mcp-settings__workspace"
          aria-label="Server workspace"
        >
          <option value="" disabled>Select a workspace</option>
          <option
            v-for="workspace in creationWorkspaceOptions"
            :key="workspace.id"
            :value="workspace.id"
          >
            {{ workspace.label }}
          </option>
        </select>
      </div>
      <label
        ><span>Name</span
        ><input
          v-model="nameInput"
          aria-label="MCP server name"
          autocomplete="off"
          :disabled="Boolean(selectedName) || saving"
      /></label>
      <label
        ><span>Server configuration (JSON)</span
        ><textarea
          v-model="configInput"
          aria-label="MCP server configuration"
          rows="9"
          spellcheck="false"
          :disabled="saving"
        />
      </label>
      <div class="mcp-settings__actions">
        <button
          class="settings-popover__action settings-popover__action--primary"
          type="submit"
          :disabled="saving || (!selectedName && !creatingGlobal && !validCreationWorkspace)"
        >
          <Save :size="14" /> {{ saving ? "Saving…" : "Save server" }}
        </button>
        <button type="button" @click="cancelEdit">Cancel</button>
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
.mcp-settings__form label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  flex: 1;
}
.mcp-settings__scope-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.mcp-settings__form .mcp-settings__switch {
  position: relative;
  flex: none;
  flex-direction: row;
  align-items: center;
  gap: 0.5rem;
  white-space: nowrap;
  cursor: pointer;
}
.mcp-settings__switch input {
  position: absolute;
  width: auto;
  opacity: 0;
  pointer-events: none;
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
.mcp-settings__workspace {
  flex: 1;
  min-width: 0;
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
.mcp-settings button:not(.settings-popover__action) {
  border: 1px solid var(--color-border-soft);
  border-radius: 0.45rem;
  background: var(--color-bg-panel-strong);
  color: inherit;
  padding: 0.4rem 0.55rem;
  font: inherit;
  font-size: 0.78rem;
  cursor: pointer;
}
.mcp-settings button:not(.settings-popover__action):disabled {
  opacity: 0.55;
  cursor: default;
}
.mcp-settings a {
  width: fit-content;
}
</style>
