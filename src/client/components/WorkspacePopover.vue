<script setup lang="ts">
import { Search, Plus, LogOut, LoaderCircle } from "lucide-vue-next";
import { computed, nextTick, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { formatShortDateTime } from "@/client/lib/formatting";
import { sessionRoutePath, workspaceRoutePath } from "@/client/lib/routes";
import type { SessionSummary } from "@/shared/types";
import { useAppStore } from "@/client/stores/app";

const props = defineProps<{
  popoverId: string;
  anchorName: string;
}>();

const emit = defineEmits<{
  close: [];
}>();

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
const isOffline = computed(() => store.connectionState === "offline");

const filteredWorkspaces = computed(() => {
  const query = workspaceFilter.value.toLowerCase().trim();
  if (!query) return store.workspaces;
  return store.workspaces.filter((w) => w.label.toLowerCase().includes(query));
});

const sessions = computed(() => store.workspaceSessions);

const filteredSessions = computed(() => {
  const query = sessionFilter.value.toLowerCase().trim();
  if (!query) return sessions.value;
  return sessions.value.filter((s) => sessionLabel(s).toLowerCase().includes(query));
});

function sessionLabel(session: SessionSummary): string {
  return (session.name || session.firstMessage || "Untitled session").replace(/\s+/g, " ").trim();
}

function resetCreateWorkspaceForm(): void {
  createWorkspaceOpen.value = false;
  createWorkspaceName.value = "";
  createWorkspaceError.value = "";
}

async function openCreateWorkspaceForm(): Promise<void> {
  if (isOffline.value) {
    return;
  }

  createWorkspaceOpen.value = true;
  createWorkspaceError.value = "";
  await nextTick();
  createWorkspaceInput.value?.focus();
}

async function submitCreateWorkspace(): Promise<void> {
  if (isOffline.value) {
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
    const workspace = await store.createWorkspace(name);
    await router.push(workspaceRoutePath(workspace.id));
    resetCreateWorkspaceForm();
    emit("close");
  } catch (error) {
    createWorkspaceError.value = error instanceof Error ? error.message : String(error);
  } finally {
    creatingWorkspace.value = false;
  }
}

async function openWorkspace(workspaceId: string): Promise<void> {
  if (isOffline.value || switchingWorkspaceId.value === workspaceId) {
    return;
  }

  switchingWorkspaceId.value = workspaceId;
  try {
    await router.push(workspaceRoutePath(workspaceId));
    emit("close");
  } finally {
    switchingWorkspaceId.value = undefined;
  }
}

async function startSession(): Promise<void> {
  if (!store.selectedWorkspaceId || isOffline.value || startingSession.value) {
    return;
  }

  startingSession.value = true;
  try {
    const session = await store.startSession(store.selectedWorkspaceId);
    await router.push(sessionRoutePath(session.workspaceId, session.sessionId));
    emit("close");
  } finally {
    startingSession.value = false;
  }
}

async function openSession(session: SessionSummary): Promise<void> {
  if (isOffline.value || openingSessionId.value === session.sessionId) {
    return;
  }

  openingSessionId.value = session.sessionId;
  try {
    await router.push(sessionRoutePath(session.workspaceId, session.sessionId));
    emit("close");
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
  <div
    :id="props.popoverId"
    class="ws-popover"
    :style="{ 'position-anchor': props.anchorName }"
    popover="auto"
  >
    <div v-if="isOffline" class="ws-popover__notice">
      Offline — workspace and session actions are disabled.
    </div>

    <div class="ws-popover__cols">
      <div class="ws-popover__left">
        <div class="ws-popover__section-label">Workspaces</div>

        <div class="ws-popover__search-row">
          <Search :size="14" class="ws-popover__search-icon" />
          <input
            v-model="workspaceFilter"
            class="ws-popover__search"
            type="text"
            placeholder="Filter workspaces…"
          />
        </div>

        <form
          v-if="createWorkspaceOpen"
          class="ws-popover__create-form"
          @submit.prevent="submitCreateWorkspace"
        >
          <input
            ref="createWorkspaceInput"
            v-model="createWorkspaceName"
            class="ws-popover__search"
            type="text"
            placeholder="workspace-name"
            :disabled="creatingWorkspace || isOffline"
          />
          <div class="ws-popover__create-btns">
            <button
              class="ws-popover__btn ws-popover__btn--primary"
              type="submit"
              :disabled="creatingWorkspace || isOffline"
            >
              <LoaderCircle v-if="creatingWorkspace" :size="14" class="ws-popover__spinner" />
              <span>{{ creatingWorkspace ? "Creating…" : "Create" }}</span>
            </button>
            <button
              class="ws-popover__btn"
              type="button"
              :disabled="creatingWorkspace"
              @click="resetCreateWorkspaceForm"
            >
              Cancel
            </button>
          </div>
          <p v-if="createWorkspaceError" class="ws-popover__error">{{ createWorkspaceError }}</p>
        </form>
        <button
          v-else
          class="ws-popover__btn ws-popover__btn--primary"
          :disabled="isOffline"
          @click="openCreateWorkspaceForm"
        >
          <Plus :size="14" /> New workspace
        </button>

        <div class="ws-popover__list">
          <button
            v-for="workspace in filteredWorkspaces"
            :key="workspace.id"
            :class="[
              'ws-popover__item',
              workspace.id === store.selectedWorkspaceId ? 'is-active' : '',
            ]"
            :disabled="isOffline"
            @click="openWorkspace(workspace.id)"
          >
            <span class="ws-popover__item-main">
              <span class="ws-popover__item-label">{{ workspace.label }}</span>
              <LoaderCircle
                v-if="
                  switchingWorkspaceId === workspace.id ||
                  store.routeLoadingWorkspaceId === workspace.id
                "
                :size="14"
                class="ws-popover__spinner"
              />
            </span>
            <span class="ws-popover__item-meta">{{ workspace.path }}</span>
          </button>

          <div v-if="filteredWorkspaces.length === 0" class="ws-popover__empty">
            No workspaces match.
          </div>
        </div>

        <button class="ws-popover__logout" @click="store.logout">
          <LogOut :size="14" /> Log out
        </button>
      </div>

      <div class="ws-popover__right">
        <div class="ws-popover__section-label">Sessions</div>

        <div class="ws-popover__search-row">
          <Search :size="14" class="ws-popover__search-icon" />
          <input
            v-model="sessionFilter"
            class="ws-popover__search"
            type="text"
            placeholder="Filter sessions…"
          />
        </div>

        <button
          v-if="store.selectedWorkspaceId"
          class="ws-popover__btn ws-popover__btn--primary ws-popover__new-session"
          :disabled="isOffline || startingSession"
          @click="startSession"
        >
          <LoaderCircle v-if="startingSession" :size="14" class="ws-popover__spinner" />
          <Plus v-else :size="14" />
          {{ startingSession ? "Starting…" : "New session" }}
        </button>

        <div class="ws-popover__sessions">
          <button
            v-for="session in filteredSessions"
            :key="session.id"
            :class="[
              'ws-popover__item',
              session.sessionId === store.activeSession?.sessionId ? 'is-active' : '',
            ]"
            :disabled="isOffline"
            @click="openSession(session)"
          >
            <span class="ws-popover__item-label">{{ sessionLabel(session) }}</span>
            <span class="ws-popover__item-meta">{{ formatShortDateTime(session.updatedAt) }}</span>
          </button>
          <div v-if="filteredSessions.length === 0" class="ws-popover__empty">No sessions yet.</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ws-popover {
  display: none;
}

.ws-popover:popover-open {
  position: absolute;
  top: calc(anchor(bottom) + 0.3rem);
  left: anchor(left);
  right: auto;
  width: min(38rem, calc(100vw - 1.5rem));
  max-height: min(32rem, calc(100dvh - 4rem));
  display: block;
  margin: 0;
  padding: 0;
  border: 1px solid var(--color-border-soft);
  border-radius: 0.75rem;
  background: var(--color-bg-overlay);
  color: inherit;
  box-shadow: var(--color-shadow-popover);
  overflow: hidden;
}

.ws-popover::backdrop {
  background: var(--color-backdrop);
}

.ws-popover__notice {
  padding: 0.55rem 0.75rem;
  border-bottom: 1px solid var(--color-border-soft);
  background: var(--color-warning-soft);
  color: var(--color-warning);
  font-size: 0.82rem;
}

.ws-popover__cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: minmax(16rem, 1fr);
  height: min(32rem, calc(100dvh - 4rem));
}

.ws-popover__left,
.ws-popover__right {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  padding: 0.5rem;
  gap: 0.35rem;
  overflow: hidden;
}

.ws-popover__left {
  border-right: 1px solid var(--color-border-soft);
}

.ws-popover__search-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.35rem 0.5rem;
  background: var(--color-bg-elevated);
  border-radius: 0.5rem;
}

.ws-popover__search-icon {
  color: var(--color-text-subtle);
  flex-shrink: 0;
}

.ws-popover__search {
  flex: 1;
  border: 0;
  background: transparent;
  color: inherit;
  font-size: 0.88rem;
  outline: none;
  padding: 0;
}

.ws-popover__list,
.ws-popover__sessions {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.ws-popover__item {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  width: 100%;
  text-align: left;
  border: 0;
  border-radius: 0.4rem;
  background: transparent;
  color: inherit;
  padding: 0.4rem 0.5rem;
  font-size: 0.88rem;
  transition: background 80ms ease;
}

.ws-popover__item:hover:not(:disabled) {
  background: var(--color-bg-elevated);
}

.ws-popover__item:disabled {
  opacity: 0.55;
  cursor: default;
}

.ws-popover__item.is-active {
  background: var(--color-user-bg);
  color: var(--color-user-text);
}

.ws-popover__item-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.4rem;
  min-width: 0;
}

.ws-popover__item-label {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ws-popover__item-meta {
  font-size: 0.78rem;
  color: var(--color-text-subtle);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ws-popover__item.is-active .ws-popover__item-meta {
  color: var(--color-user-text);
  opacity: 0.7;
}

.ws-popover__section-label {
  font-size: 0.72rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-subtle);
  padding: 0.2rem 0.5rem;
}

.ws-popover__create-form {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.ws-popover__create-btns {
  display: flex;
  gap: 0.25rem;
}

.ws-popover__btn {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  width: 100%;
  border: 0;
  border-radius: 0.4rem;
  background: var(--color-bg-elevated);
  color: inherit;
  padding: 0.4rem 0.5rem;
  font-size: 0.85rem;
  transition: background 80ms ease;
}

.ws-popover__btn:hover:not(:disabled) {
  background: var(--color-border-soft);
}

.ws-popover__btn:disabled {
  opacity: 0.55;
  cursor: default;
}

.ws-popover__btn--primary {
  background: var(--color-bg-selection);
  color: var(--color-accent-strong);
  font-weight: 500;
}

.ws-popover__btn--primary:hover {
  background: var(--color-accent-soft);
}

.ws-popover__new-session {
  flex-shrink: 0;
}

.ws-popover__error {
  margin: 0;
  color: var(--color-error);
  font-size: 0.78rem;
  padding: 0 0.2rem;
}

.ws-popover__empty {
  padding: 0.6rem 0.5rem;
  color: var(--color-text-subtle);
  font-size: 0.85rem;
}

.ws-popover__logout {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  width: 100%;
  border: 0;
  border-radius: 0.4rem;
  background: transparent;
  color: var(--color-text-muted);
  padding: 0.4rem 0.5rem;
  font-size: 0.82rem;
  margin-top: auto;
  transition:
    background 80ms ease,
    color 80ms ease;
}

.ws-popover__logout:hover {
  background: var(--color-error-soft);
  color: var(--color-error);
}

.ws-popover__spinner {
  flex-shrink: 0;
  animation: ws-popover-spin 0.85s linear infinite;
}

@keyframes ws-popover-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
