<script setup lang="ts">
import { Search, Plus, LogOut, LoaderCircle, Wifi, WifiOff } from "lucide-vue-next";
import { computed, nextTick, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { formatShortDateTime } from "@/client/lib/formatting";
import { sessionRoutePath, workspaceRoutePath } from "@/client/lib/routes";
import type { SessionSummary } from "@/shared/types";
import { useAppStore } from "@/client/stores/app";

const store = useAppStore();
const router = useRouter();
const workspaceFilter = ref("");
const sessionFilter = ref("");
const createWorkspaceOpen = ref(false);
const createWorkspaceName = ref("");
const createWorkspaceError = ref("");
const creatingWorkspace = ref(false);
const switchingWorkspaceId = ref<string>();
const startingSession = ref(false);
const openingSessionId = ref<string>();
const createWorkspaceInput = ref<HTMLInputElement>();
const actionsDisabled = computed(() => store.connectionState !== "online");

const filteredWorkspaces = computed(() => {
  const query = workspaceFilter.value.toLowerCase().trim();
  if (!query) return store.workspaces;
  return store.workspaces.filter((workspace) => {
    const haystack = `${workspace.label} ${workspace.path}`.toLowerCase();
    return haystack.includes(query);
  });
});

const sessions = computed(() => store.workspaceSessions);

const filteredSessions = computed(() => {
  const query = sessionFilter.value.toLowerCase().trim();
  if (!query) return sessions.value;
  return sessions.value.filter((session) => sessionLabel(session).toLowerCase().includes(query));
});

const sessionListLoading = computed(() => {
  const workspaceId = store.selectedWorkspaceId;
  if (!workspaceId) {
    return false;
  }

  return Boolean(
    switchingWorkspaceId.value === workspaceId ||
    store.routeLoadingWorkspaceId === workspaceId ||
    store.loadingWorkspaceSessions[workspaceId],
  );
});

const connectionDescription = computed(() => {
  switch (store.connectionState) {
    case "online":
      return "Connected";
    case "connecting":
      return "Connecting";
    default:
      return "Offline";
  }
});

function sessionLabel(session: SessionSummary): string {
  return (session.name || session.firstMessage).replace(/\s+/g, " ").trim();
}

function resetCreateWorkspaceForm(): void {
  createWorkspaceOpen.value = false;
  createWorkspaceName.value = "";
  createWorkspaceError.value = "";
}

async function openCreateWorkspaceForm(): Promise<void> {
  if (actionsDisabled.value) {
    return;
  }

  createWorkspaceOpen.value = true;
  createWorkspaceError.value = "";
  await nextTick();
  createWorkspaceInput.value?.focus();
}

async function submitCreateWorkspace(): Promise<void> {
  if (actionsDisabled.value) {
    return;
  }

  const name = createWorkspaceName.value.trim();
  if (!name) {
    createWorkspaceError.value = "Workspace name is required";
    await nextTick();
    createWorkspaceInput.value?.focus();
    return;
  }

  creatingWorkspace.value = true;
  createWorkspaceError.value = "";
  try {
    const session = await store.createWorkspace(name);
    await router.push(sessionRoutePath(session.workspaceId, session.sessionId));
    resetCreateWorkspaceForm();
  } catch (error) {
    createWorkspaceError.value = error instanceof Error ? error.message : String(error);
  } finally {
    creatingWorkspace.value = false;
  }
}

async function openWorkspace(workspaceId: string): Promise<void> {
  if (actionsDisabled.value || switchingWorkspaceId.value === workspaceId) {
    return;
  }

  switchingWorkspaceId.value = workspaceId;
  try {
    await router.push(workspaceRoutePath(workspaceId));
  } finally {
    switchingWorkspaceId.value = undefined;
  }
}

async function startSession(): Promise<void> {
  if (!store.selectedWorkspaceId || actionsDisabled.value || startingSession.value) {
    return;
  }

  startingSession.value = true;
  try {
    const session = await store.startSession(store.selectedWorkspaceId);
    await router.push(sessionRoutePath(session.workspaceId, session.sessionId));
  } finally {
    startingSession.value = false;
  }
}

async function openSession(session: SessionSummary): Promise<void> {
  if (actionsDisabled.value || openingSessionId.value === session.sessionId) {
    return;
  }

  openingSessionId.value = session.sessionId;
  try {
    await router.push(sessionRoutePath(session.workspaceId, session.sessionId));
  } finally {
    openingSessionId.value = undefined;
  }
}

watch(
  () => store.selectedWorkspaceId,
  () => {
    workspaceFilter.value = "";
    sessionFilter.value = "";
  },
);
</script>

<template>
  <section class="workspace-browser-pane">
    <header class="workspace-browser-pane__header">
      <div class="workspace-browser-pane__brand">
        <img src="/favicon.png" alt="Batty" class="workspace-browser-pane__brand-icon" />
        <div class="workspace-browser-pane__brand-copy">
          <h1>Batty</h1>
          <p>Workspaces & sessions</p>
        </div>
      </div>

      <div class="workspace-browser-pane__header-actions">
        <span
          class="workspace-browser-pane__status"
          :aria-label="connectionDescription"
          :title="connectionDescription"
        >
          <Wifi
            v-if="store.connectionState === 'online'"
            :size="15"
            class="workspace-browser-pane__status-icon workspace-browser-pane__status-icon--online"
          />
          <LoaderCircle
            v-else-if="store.connectionState === 'connecting'"
            :size="15"
            class="workspace-browser-pane__status-icon workspace-browser-pane__status-icon--spin"
          />
          <WifiOff
            v-else
            :size="15"
            class="workspace-browser-pane__status-icon workspace-browser-pane__status-icon--offline"
          />
        </span>

        <button class="workspace-browser-pane__logout" @click="store.logout">
          <LogOut :size="14" /> Log out
        </button>
      </div>
    </header>

    <div v-if="actionsDisabled" class="workspace-browser-pane__notice">
      Offline or reconnecting — workspace and session actions are disabled.
    </div>

    <div class="workspace-browser-pane__cols">
      <section class="workspace-browser-pane__column">
        <div class="workspace-browser-pane__section-label">Workspaces</div>

        <div class="workspace-browser-pane__search-row">
          <Search :size="14" class="workspace-browser-pane__search-icon" />
          <input
            v-model="workspaceFilter"
            class="workspace-browser-pane__search"
            type="text"
            placeholder="Filter workspaces…"
          />
        </div>

        <form
          v-if="createWorkspaceOpen"
          class="workspace-browser-pane__create-form"
          @submit.prevent="submitCreateWorkspace"
        >
          <input
            ref="createWorkspaceInput"
            v-model="createWorkspaceName"
            class="workspace-browser-pane__search"
            type="text"
            placeholder="workspace-name"
            :disabled="creatingWorkspace || actionsDisabled"
          />
          <div class="workspace-browser-pane__create-btns">
            <button
              class="workspace-browser-pane__btn workspace-browser-pane__btn--primary"
              type="submit"
              :disabled="creatingWorkspace || actionsDisabled"
            >
              <LoaderCircle
                v-if="creatingWorkspace"
                :size="14"
                class="workspace-browser-pane__spinner"
              />
              <span>{{ creatingWorkspace ? "Creating…" : "Create" }}</span>
            </button>
            <button
              class="workspace-browser-pane__btn"
              type="button"
              :disabled="creatingWorkspace"
              @click="resetCreateWorkspaceForm"
            >
              Cancel
            </button>
          </div>
          <p v-if="createWorkspaceError" class="workspace-browser-pane__error">
            {{ createWorkspaceError }}
          </p>
        </form>

        <button
          v-else
          class="workspace-browser-pane__btn workspace-browser-pane__btn--primary"
          :disabled="actionsDisabled"
          @click="openCreateWorkspaceForm"
        >
          <Plus :size="14" /> New workspace
        </button>

        <div class="workspace-browser-pane__list">
          <button
            v-for="workspace in filteredWorkspaces"
            :key="workspace.id"
            :class="[
              'workspace-browser-pane__item',
              workspace.id === store.selectedWorkspaceId ? 'is-active' : '',
            ]"
            :disabled="actionsDisabled"
            @click="openWorkspace(workspace.id)"
          >
            <span class="workspace-browser-pane__item-main">
              <span class="workspace-browser-pane__item-label">{{ workspace.label }}</span>
            </span>
            <span class="workspace-browser-pane__item-meta">{{ workspace.path }}</span>
          </button>

          <div v-if="filteredWorkspaces.length === 0" class="workspace-browser-pane__empty">
            No workspaces match.
          </div>
        </div>
      </section>

      <section class="workspace-browser-pane__column workspace-browser-pane__column--sessions">
        <div class="workspace-browser-pane__section-label">Sessions</div>

        <div class="workspace-browser-pane__workspace-meta">
          <strong>{{ store.selectedWorkspace?.label || "No workspace selected" }}</strong>
          <span>{{ store.selectedWorkspace?.path }}</span>
        </div>

        <div class="workspace-browser-pane__search-row">
          <Search :size="14" class="workspace-browser-pane__search-icon" />
          <input
            v-model="sessionFilter"
            class="workspace-browser-pane__search"
            type="text"
            placeholder="Filter sessions…"
          />
        </div>

        <button
          v-if="store.selectedWorkspaceId"
          class="workspace-browser-pane__btn workspace-browser-pane__btn--primary workspace-browser-pane__new-session"
          :disabled="actionsDisabled || startingSession"
          @click="startSession"
        >
          <LoaderCircle v-if="startingSession" :size="14" class="workspace-browser-pane__spinner" />
          <Plus v-else :size="14" />
          {{ startingSession ? "Starting…" : "New session" }}
        </button>

        <div class="workspace-browser-pane__sessions">
          <template v-if="sessionListLoading">
            <div class="workspace-browser-pane__empty workspace-browser-pane__empty--loading">
              <LoaderCircle :size="18" class="workspace-browser-pane__spinner" />
            </div>
          </template>
          <template v-else>
            <button
              v-for="session in filteredSessions"
              :key="session.id"
              :class="[
                'workspace-browser-pane__item',
                session.sessionId === store.activeSession?.sessionId ? 'is-active' : '',
              ]"
              :disabled="actionsDisabled"
              @click="openSession(session)"
            >
              <span class="workspace-browser-pane__item-label">{{ sessionLabel(session) }}</span>
              <span class="workspace-browser-pane__item-meta">{{
                formatShortDateTime(session.updatedAt)
              }}</span>
            </button>

            <div v-if="filteredSessions.length === 0" class="workspace-browser-pane__empty">
              No sessions yet.
            </div>
          </template>
        </div>
      </section>
    </div>
  </section>
</template>

<style scoped>
.workspace-browser-pane {
  width: 100%;
  height: 100%;
  min-height: 0;
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  background: var(--color-bg-app);
  overflow: hidden;
}

.workspace-browser-pane__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: calc(var(--safe-area-top) + 0.9rem) calc(var(--safe-area-right) + 1rem) 0.9rem
    calc(var(--safe-area-left) + 1rem);
  border-bottom: 1px solid var(--color-border-soft);
  background: var(--color-bg-panel);
}

.workspace-browser-pane__brand {
  display: flex;
  align-items: center;
  gap: 0.8rem;
  min-width: 0;
}

.workspace-browser-pane__brand-icon {
  width: 2.4rem;
  height: 2.4rem;
  border-radius: 0.65rem;
  flex-shrink: 0;
}

.workspace-browser-pane__brand-copy {
  min-width: 0;
}

.workspace-browser-pane__brand-copy h1,
.workspace-browser-pane__brand-copy p {
  margin: 0;
}

.workspace-browser-pane__brand-copy h1 {
  font-size: 1.2rem;
  line-height: 1.1;
  color: var(--color-text-strong);
}

.workspace-browser-pane__brand-copy p {
  color: var(--color-text-subtle);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.workspace-browser-pane__header-actions {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-shrink: 0;
}

.workspace-browser-pane__status,
.workspace-browser-pane__status-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.workspace-browser-pane__status-icon--online {
  color: var(--color-success);
}

.workspace-browser-pane__status-icon--offline {
  color: var(--color-warning);
}

.workspace-browser-pane__status-icon--spin {
  color: var(--color-text-subtle);
  animation: workspace-browser-pane-spin 0.85s linear infinite;
}

.workspace-browser-pane__logout {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  border: 0;
  border-radius: 0.55rem;
  background: transparent;
  color: var(--color-text-muted);
  padding: 0.45rem 0.65rem;
  transition:
    background 80ms ease,
    color 80ms ease;
}

.workspace-browser-pane__logout:hover {
  background: var(--color-error-soft);
  color: var(--color-error);
}

.workspace-browser-pane__notice {
  padding: 0.7rem 1rem;
  border-bottom: 1px solid var(--color-border-soft);
  background: var(--color-warning-soft);
  color: var(--color-warning);
  font-size: 0.9rem;
}

.workspace-browser-pane__cols {
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 20rem) minmax(0, 1fr);
}

.workspace-browser-pane__column {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  gap: 0.45rem;
  padding: 0.8rem;
  overflow: hidden;
}

.workspace-browser-pane__column--sessions {
  border-left: 1px solid var(--color-border-soft);
}

.workspace-browser-pane__section-label {
  font-size: 0.75rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-text-subtle);
  padding: 0.2rem 0.35rem;
}

.workspace-browser-pane__workspace-meta {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  padding: 0 0.35rem;
  min-width: 0;
}

.workspace-browser-pane__workspace-meta strong,
.workspace-browser-pane__workspace-meta span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-browser-pane__workspace-meta strong {
  color: var(--color-text-strong);
}

.workspace-browser-pane__workspace-meta span {
  color: var(--color-text-subtle);
  font-size: 0.84rem;
}

.workspace-browser-pane__search-row {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.5rem 0.6rem;
  background: var(--color-bg-elevated);
  border-radius: 0.6rem;
}

.workspace-browser-pane__search-icon {
  color: var(--color-text-subtle);
  flex-shrink: 0;
}

.workspace-browser-pane__search {
  flex: 1;
  min-width: 0;
  border: 0;
  background: transparent;
  color: inherit;
  outline: none;
  padding: 0;
}

.workspace-browser-pane__create-form {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.workspace-browser-pane__create-btns {
  display: flex;
  gap: 0.3rem;
}

.workspace-browser-pane__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  width: 100%;
  border: 0;
  border-radius: 0.55rem;
  background: var(--color-bg-elevated);
  color: inherit;
  padding: 0.55rem 0.7rem;
  transition: background 80ms ease;
}

.workspace-browser-pane__btn:hover:not(:disabled) {
  background: var(--color-bg-hover);
}

.workspace-browser-pane__btn:disabled,
.workspace-browser-pane__item:disabled {
  opacity: 0.55;
  cursor: default;
}

.workspace-browser-pane__btn--primary {
  background: var(--color-bg-selection);
  color: var(--color-accent-strong);
  font-weight: 600;
}

.workspace-browser-pane__btn--primary:hover:not(:disabled) {
  background: var(--color-accent-soft);
}

.workspace-browser-pane__new-session {
  flex-shrink: 0;
}

.workspace-browser-pane__error {
  margin: 0;
  color: var(--color-error);
  font-size: 0.82rem;
  padding: 0 0.2rem;
}

.workspace-browser-pane__list,
.workspace-browser-pane__sessions {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding-right: 0.1rem;
}

.workspace-browser-pane__item {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  width: 100%;
  text-align: left;
  border: 0;
  border-radius: 0.55rem;
  background: transparent;
  color: inherit;
  padding: 0.55rem 0.65rem;
  transition: background 80ms ease;
}

.workspace-browser-pane__item:hover:not(:disabled):not(.is-active) {
  background: var(--color-bg-hover);
}

.workspace-browser-pane__item.is-active {
  background: var(--color-user-bg);
  color: var(--color-user-text);
}

.workspace-browser-pane__item-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.45rem;
  min-width: 0;
}

.workspace-browser-pane__item-label {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-browser-pane__item-meta {
  font-size: 0.82rem;
  color: var(--color-text-subtle);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-browser-pane__item.is-active .workspace-browser-pane__item-meta {
  color: var(--color-user-text);
  opacity: 0.76;
}

.workspace-browser-pane__empty {
  padding: 0.8rem 0.4rem;
  color: var(--color-text-subtle);
}

.workspace-browser-pane__empty--loading {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.workspace-browser-pane__spinner {
  flex-shrink: 0;
  animation: workspace-browser-pane-spin 0.85s linear infinite;
}

@keyframes workspace-browser-pane-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
