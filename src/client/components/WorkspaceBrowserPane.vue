<script setup lang="ts">
import {
  Search,
  Plus,
  LogOut,
  LoaderCircle,
  Wifi,
  WifiOff,
  KeyRound,
  Star,
  CalendarDays,
} from "lucide-vue-next";
import ProviderAuthPopover from "@/client/components/ProviderAuthPopover.vue";
import { computed, nextTick, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { formatShortDateTime } from "@/client/lib/formatting";
import { usePaneTransition } from "@/client/lib/pane-transition";
import { sessionRoutePath, workspaceRoutePath } from "@/client/lib/routes";
import { sessionDisplayTitle } from "@/client/lib/daily-sessions";
import type { SessionSummary } from "@/shared/types";
import { useAppStore } from "@/client/stores/app";

const PROVIDER_AUTH_POPOVER_ID = "workspace-provider-auth-popover";
const PROVIDER_AUTH_POPOVER_ANCHOR = "--workspace-provider-auth-anchor";

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
const { setPaneTransition } = usePaneTransition();

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
  return sessionDisplayTitle(session);
}

function sessionMeta(session: SessionSummary): string {
  if (session.dailySession && !session.dailySession.exists) {
    return "";
  }

  return formatShortDateTime(session.updatedAt);
}

function isWorkspacePinned(workspaceId: string): boolean {
  return store.workspaces.some((workspace) => workspace.id === workspaceId && workspace.isPinned);
}

async function toggleWorkspacePin(workspaceId: string): Promise<void> {
  try {
    await store.toggleWorkspacePin(workspaceId);
  } catch (error) {
    console.error(error);
  }
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
    setPaneTransition("slide-from-right");
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
    setPaneTransition("slide-from-right");
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
    if (session.dailySession && !session.dailySession.exists) {
      const openedSession = await store.startDailySession(session.workspaceId);
      setPaneTransition("slide-from-right");
      await router.push(sessionRoutePath(openedSession.workspaceId, openedSession.sessionId));
      return;
    }

    setPaneTransition("slide-from-right");
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

        <button
          class="workspace-browser-pane__header-btn"
          type="button"
          :style="{ 'anchor-name': PROVIDER_AUTH_POPOVER_ANCHOR }"
          :popovertarget="PROVIDER_AUTH_POPOVER_ID"
        >
          <KeyRound :size="14" /> Auth
        </button>

        <ProviderAuthPopover
          :popover-id="PROVIDER_AUTH_POPOVER_ID"
          :anchor-name="PROVIDER_AUTH_POPOVER_ANCHOR"
        />

        <button class="workspace-browser-pane__logout" @click="store.logout">
          <LogOut :size="14" /> Log out
        </button>
      </div>
    </header>

    <div v-if="actionsDisabled" class="workspace-browser-pane__notice">
      Offline or reconnecting — workspace and session actions are disabled.
    </div>

    <div class="workspace-browser-pane__cols">
      <section class="workspace-browser-pane__column workspace-browser-pane__column--workspaces">
        <div class="workspace-browser-pane__section-label">Workspaces</div>

        <div
          class="workspace-browser-pane__search-row workspace-browser-pane__search-row--workspaces"
        >
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
          class="workspace-browser-pane__btn workspace-browser-pane__btn--primary workspace-browser-pane__btn--workspaces"
          :disabled="actionsDisabled"
          @click="openCreateWorkspaceForm"
        >
          <Plus :size="14" /> New workspace
        </button>

        <div class="workspace-browser-pane__list">
          <div
            v-for="workspace in filteredWorkspaces"
            :key="workspace.id"
            :class="[
              'workspace-browser-pane__item-row',
              'workspace-browser-pane__item-row--workspace',
              workspace.id === store.selectedWorkspaceId ? 'is-active' : '',
            ]"
          >
            <button
              class="workspace-browser-pane__item workspace-browser-pane__item--workspace"
              :disabled="actionsDisabled"
              @click="openWorkspace(workspace.id)"
            >
              <span class="workspace-browser-pane__item-main">
                <span class="workspace-browser-pane__item-label">{{ workspace.label }}</span>
              </span>
              <span class="workspace-browser-pane__item-meta">{{ workspace.path }}</span>
            </button>

            <button
              class="workspace-browser-pane__pin-btn"
              type="button"
              :class="isWorkspacePinned(workspace.id) ? 'is-pinned' : ''"
              :aria-label="isWorkspacePinned(workspace.id) ? 'Unpin workspace' : 'Pin workspace'"
              :title="isWorkspacePinned(workspace.id) ? 'Unpin workspace' : 'Pin workspace'"
              @click.stop="void toggleWorkspacePin(workspace.id)"
            >
              <Star :size="16" :fill="isWorkspacePinned(workspace.id) ? 'currentColor' : 'none'" />
            </button>
          </div>

          <div v-if="filteredWorkspaces.length === 0" class="workspace-browser-pane__empty">
            No workspaces match.
          </div>
        </div>
      </section>

      <section class="workspace-browser-pane__column workspace-browser-pane__column--sessions">
        <div class="workspace-browser-pane__section-label">Sessions</div>

        <div
          class="workspace-browser-pane__search-row workspace-browser-pane__search-row--sessions"
        >
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
          class="workspace-browser-pane__btn workspace-browser-pane__btn--primary workspace-browser-pane__btn--sessions workspace-browser-pane__new-session"
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
                'workspace-browser-pane__item--session',
                session.sessionId === store.activeSession?.sessionId ? 'is-active' : '',
              ]"
              :disabled="actionsDisabled"
              @click="openSession(session)"
            >
              <span class="workspace-browser-pane__session-main">
                <span class="workspace-browser-pane__session-copy">
                  <span class="workspace-browser-pane__item-label">{{
                    sessionLabel(session)
                  }}</span>
                  <span v-if="sessionMeta(session)" class="workspace-browser-pane__item-meta">
                    {{ sessionMeta(session) }}
                  </span>
                </span>
                <span
                  v-if="session.dailySession"
                  class="workspace-browser-pane__session-icon"
                  :title="session.dailySession.exists ? 'Daily session' : 'Start daily session'"
                  :aria-label="
                    session.dailySession.exists ? 'Daily session' : 'Start daily session'
                  "
                >
                  <CalendarDays :size="16" />
                </span>
              </span>
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

.workspace-browser-pane__brand-copy h1 {
  margin: 0;
  font-size: 1.2rem;
  line-height: 1.1;
  color: var(--color-text-strong);
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

.workspace-browser-pane__header-btn,
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

.workspace-browser-pane__header-btn:hover {
  background: var(--color-bg-elevated);
  color: var(--color-text-strong);
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
  grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: 0.45rem;
}

.workspace-browser-pane__column {
  --workspace-browser-pane-safe-start: 0px;
  --workspace-browser-pane-safe-end: 0px;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  gap: 0.45rem;
  padding-block: 0.8rem;
  overflow: hidden;
}

.workspace-browser-pane__column--workspaces {
  --workspace-browser-pane-safe-start: var(--safe-area-left);
  padding-left: 0;
  padding-right: 0.225rem;
}

.workspace-browser-pane__column--sessions {
  --workspace-browser-pane-safe-end: var(--safe-area-right);
  padding-left: 0.225rem;
  padding-right: 0;
}

.workspace-browser-pane__section-label {
  font-size: 0.75rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-text-subtle);
  padding: 0.2rem calc(var(--workspace-browser-pane-safe-end) + 0.35rem) 0.2rem
    calc(var(--workspace-browser-pane-safe-start) + 0.35rem);
}

.workspace-browser-pane__search-row {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.5rem calc(var(--workspace-browser-pane-safe-end) + 0.6rem) 0.5rem
    calc(var(--workspace-browser-pane-safe-start) + 0.6rem);
  background: var(--color-bg-elevated);
  border-radius: 0.6rem;
}

.workspace-browser-pane__search-row--workspaces {
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
}

.workspace-browser-pane__search-row--sessions {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
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
  padding: 0.55rem calc(var(--workspace-browser-pane-safe-end) + 0.7rem) 0.55rem
    calc(var(--workspace-browser-pane-safe-start) + 0.7rem);
  transition: background 80ms ease;
}

.workspace-browser-pane__btn--workspaces {
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
}

.workspace-browser-pane__btn--sessions {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
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
  padding: 0 calc(var(--workspace-browser-pane-safe-end) + 0.2rem) 0
    calc(var(--workspace-browser-pane-safe-start) + 0.2rem);
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

.workspace-browser-pane__item-row {
  display: flex;
  align-items: stretch;
  gap: 0.2rem;
  border-radius: 0.55rem;
  background: transparent;
  color: inherit;
  transition:
    background 80ms ease,
    color 80ms ease;
}

.workspace-browser-pane__item-row--workspace {
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
}

.workspace-browser-pane__item-row:hover:not(.is-active) {
  background: var(--color-bg-hover);
}

.workspace-browser-pane__item-row.is-active {
  background: var(--color-user-bg);
  color: var(--color-user-text);
}

.workspace-browser-pane__item {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
  text-align: left;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: inherit;
  padding: 0.55rem calc(var(--workspace-browser-pane-safe-end) + 0.65rem) 0.55rem
    calc(var(--workspace-browser-pane-safe-start) + 0.65rem);
}

.workspace-browser-pane__item--workspace {
  flex: 1;
  padding-right: 0.35rem;
}

.workspace-browser-pane__item--session {
  flex: 0 0 auto;
}

.workspace-browser-pane__session-main {
  display: flex;
  align-items: stretch;
  justify-content: space-between;
  gap: 0.45rem;
  min-width: 0;
}

.workspace-browser-pane__session-copy {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 0.15rem;
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

.workspace-browser-pane__item.is-active .workspace-browser-pane__item-meta,
.workspace-browser-pane__item-row.is-active .workspace-browser-pane__item-meta {
  color: var(--color-user-text);
  opacity: 0.76;
}

.workspace-browser-pane__pin-btn,
.workspace-browser-pane__session-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  align-self: stretch;
  flex-shrink: 0;
  aspect-ratio: 1;
  height: 100%;
  padding: 0.35rem;
  box-sizing: border-box;
  border: 0;
  border-radius: 0.5rem;
  background: transparent;
  color: var(--color-text-subtle);
  appearance: none;
  -webkit-appearance: none;
  background-clip: padding-box;
  transition: color 80ms ease;
}

.workspace-browser-pane__pin-btn:hover {
  background: transparent;
  color: var(--color-text-strong);
}

.workspace-browser-pane__session-icon {
  color: var(--color-text-strong);
}

.workspace-browser-pane__item.is-active .workspace-browser-pane__session-icon {
  color: var(--color-user-text);
  opacity: 0.76;
}

.workspace-browser-pane__empty {
  padding: 0.8rem calc(var(--workspace-browser-pane-safe-end) + 0.4rem) 0.8rem
    calc(var(--workspace-browser-pane-safe-start) + 0.4rem);
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
