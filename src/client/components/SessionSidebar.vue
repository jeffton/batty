<script setup lang="ts">
import { LoaderCircle } from "lucide-vue-next";
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { formatShortDateTime } from "@/client/lib/formatting";
import { sessionRoutePath, workspaceRoutePath } from "@/client/lib/routes";
import type { SessionSummary } from "@/shared/types";
import { useAppStore } from "@/client/stores/app";

const store = useAppStore();
const router = useRouter();
const workspaces = computed(() => store.workspaces);
const sessions = computed(() => store.workspaceSessions);
const sessionList = ref<HTMLElement>();
const createWorkspaceInput = ref<HTMLInputElement>();
const createWorkspaceOpen = ref(false);
const createWorkspaceName = ref("");
const createWorkspaceError = ref("");
const creatingWorkspace = ref(false);
const switchingWorkspaceId = ref<string>();
const startingSession = ref(false);
const openingSessionId = ref<string>();
const isOffline = computed(() => store.connectionState === "offline");

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
  } catch (error) {
    createWorkspaceError.value = error instanceof Error ? error.message : String(error);
  } finally {
    creatingWorkspace.value = false;
  }
}

async function scrollSessionsToTop(): Promise<void> {
  await nextTick();
  const element = sessionList.value;
  if (!element) {
    return;
  }
  element.scrollTo({ top: 0, behavior: "auto" });
}

async function openWorkspace(workspaceId: string): Promise<void> {
  if (isOffline.value || switchingWorkspaceId.value === workspaceId) {
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
  if (!store.selectedWorkspaceId || isOffline.value || startingSession.value) {
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
  if (isOffline.value || openingSessionId.value === session.sessionId) {
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
  () => ({
    workspaceId: store.selectedWorkspaceId,
    activeSessionId: store.activeSession?.sessionId,
    sessionCount: sessions.value.length,
    lastSessionId: sessions.value.at(-1)?.id,
    sidebarOpen: store.mobileSidebarOpen,
  }),
  () => {
    void scrollSessionsToTop();
  },
  { immediate: true },
);

onMounted(() => {
  void scrollSessionsToTop();
});
</script>

<template>
  <aside :class="['sidebar panel', store.mobileSidebarOpen ? 'sidebar--open' : '']">
    <div class="sidebar__header">
      <div>
        <h1>Batty</h1>
        <p class="muted">Pi Coding Agent, but browser-y.</p>
      </div>
      <button class="sidebar__close" @click="store.mobileSidebarOpen = false">✕</button>
    </div>

    <div class="sidebar__actions sidebar__actions--top">
      <button class="sidebar__action sidebar__action--logout" @click="store.logout">Logout</button>
    </div>

    <p v-if="isOffline" class="sidebar__notice">
      Offline — workspace and session actions are disabled.
    </p>

    <section class="sidebar__section">
      <div class="sidebar__section-title">Workspaces</div>

      <form
        v-if="createWorkspaceOpen"
        class="sidebar__workspace-form"
        @submit.prevent="submitCreateWorkspace"
      >
        <input
          ref="createWorkspaceInput"
          v-model="createWorkspaceName"
          class="sidebar__workspace-input"
          type="text"
          placeholder="workspace-name"
          :disabled="creatingWorkspace || isOffline"
        />
        <div class="sidebar__workspace-form-actions">
          <button class="sidebar__action" type="submit" :disabled="creatingWorkspace || isOffline">
            <LoaderCircle v-if="creatingWorkspace" :size="14" class="sidebar__spinner" />
            {{ creatingWorkspace ? "Creating…" : "Create workspace" }}
          </button>
          <button
            class="sidebar__action sidebar__action--secondary"
            type="button"
            :disabled="creatingWorkspace"
            @click="resetCreateWorkspaceForm"
          >
            Cancel
          </button>
        </div>
        <p v-if="createWorkspaceError" class="sidebar__error">{{ createWorkspaceError }}</p>
      </form>

      <div class="sidebar__actions">
        <button
          v-if="!createWorkspaceOpen"
          class="sidebar__action sidebar__action--secondary"
          :disabled="isOffline"
          @click="openCreateWorkspaceForm"
        >
          + New workspace
        </button>
      </div>

      <button
        v-for="workspace in workspaces"
        :key="workspace.id"
        :class="[
          'sidebar__workspace',
          workspace.id === store.selectedWorkspaceId ? 'is-active' : '',
        ]"
        :disabled="isOffline"
        @click="openWorkspace(workspace.id)"
      >
        <strong class="sidebar__item-title">
          <span>{{ workspace.label }}</span>
          <LoaderCircle
            v-if="
              switchingWorkspaceId === workspace.id ||
              store.routeLoadingWorkspaceId === workspace.id
            "
            :size="14"
            class="sidebar__spinner"
          />
        </strong>
        <span class="muted">{{ workspace.path }}</span>
      </button>
    </section>

    <section class="sidebar__section sidebar__section--sessions">
      <div class="sidebar__section-title">Sessions</div>

      <div class="sidebar__actions">
        <button
          v-if="store.selectedWorkspaceId"
          class="sidebar__action"
          :disabled="isOffline || startingSession"
          @click="startSession"
        >
          <LoaderCircle v-if="startingSession" :size="14" class="sidebar__spinner" />
          {{ startingSession ? "Starting…" : "+ New session" }}
        </button>
      </div>

      <div ref="sessionList" class="sidebar__session-list">
        <button
          v-for="session in sessions"
          :key="session.id"
          :class="[
            'sidebar__session',
            session.sessionId === store.activeSession?.sessionId ? 'is-active' : '',
          ]"
          :disabled="isOffline"
          @click="openSession(session)"
        >
          <strong class="sidebar__session-title sidebar__item-title">
            <span>{{ sessionLabel(session) }}</span>
            <LoaderCircle
              v-if="
                openingSessionId === session.sessionId ||
                store.routeLoadingSessionId === session.sessionId
              "
              :size="14"
              class="sidebar__spinner"
            />
          </strong>
          <span class="muted">{{ formatShortDateTime(session.updatedAt) }}</span>
        </button>
        <div v-if="sessions.length === 0" class="muted">No sessions yet.</div>
      </div>
    </section>
  </aside>
</template>

<style scoped>
.sidebar {
  width: min(100vw, 17rem);
  height: 100%;
  min-height: 0;
  padding: calc(var(--safe-area-top) + 0.6rem) 0.6rem calc(var(--safe-area-bottom) + 0.6rem)
    calc(var(--safe-area-left) + 0.6rem);
  display: grid;
  gap: 0.6rem;
  grid-template-rows: auto auto auto minmax(0, 1fr);
  overflow: hidden;
  border: 0;
  border-radius: 0;
  box-shadow: none;
  backdrop-filter: none;
  border-right: 1px solid var(--color-border-soft);
  background: var(--color-bg-overlay);
}

.sidebar__header {
  display: flex;
  justify-content: space-between;
  gap: 0.6rem;
}

.sidebar__header h1,
.sidebar__header p {
  margin: 0;
}

.sidebar__header h1 {
  font-size: 1rem;
}

.sidebar__header p {
  margin-top: 0.2rem;
  font-size: 0.82rem;
}

.sidebar__close {
  display: none;
  border: 0;
  background: transparent;
  color: var(--color-text-strong);
  font-size: 1rem;
}

.sidebar__notice {
  margin: 0;
  padding: 0.55rem 0.65rem;
  border-radius: 0.45rem;
  background: var(--color-warning-soft);
  color: var(--color-warning);
  font-size: 0.82rem;
}

.sidebar__section {
  display: grid;
  gap: 0.25rem;
}

.sidebar__section--sessions {
  min-height: 0;
  grid-template-rows: auto auto minmax(0, 1fr);
}

.sidebar__section-title {
  font-size: 0.78rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-text-subtle);
}

.sidebar__workspace,
.sidebar__session {
  width: 100%;
  text-align: left;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: inherit;
  padding: 0.35rem 0 0.35rem 0.55rem;
  display: grid;
  border-left: 2px solid transparent;
}

.sidebar__actions,
.sidebar__workspace-form,
.sidebar__workspace-form-actions {
  display: grid;
  gap: 0.25rem;
}

.sidebar__actions--top {
  margin-top: -0.1rem;
}

.sidebar__action {
  width: 100%;
  text-align: left;
  border: 0;
  border-radius: 0.45rem;
  background: var(--color-success-soft-strong);
  color: inherit;
  padding: 0.5rem 0.65rem;
  display: grid;
  gap: 0.1rem;
  font-size: 0.88rem;
}

.sidebar__action:disabled,
.sidebar__workspace:disabled,
.sidebar__session:disabled {
  opacity: 0.55;
  cursor: default;
}

.sidebar__action--secondary {
  background: var(--color-bg-elevated-soft);
}

.sidebar__action--logout {
  background: var(--color-error-soft-strong);
}

.sidebar__workspace-input {
  width: 100%;
  border-radius: 0.45rem;
  border: 1px solid var(--color-border-strong);
  background: var(--color-bg-elevated);
  color: inherit;
  padding: 0.5rem 0.65rem;
  font-size: 0.88rem;
}

.sidebar__error {
  margin: 0;
  color: var(--color-error);
  font-size: 0.78rem;
}

.sidebar__workspace {
  gap: 0.1rem;
  font-size: 0.88rem;
}

.sidebar__session {
  gap: 0.12rem;
  font-size: 0.88rem;
  align-content: start;
}

.sidebar__workspace strong,
.sidebar__session-title {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sidebar__item-title {
  display: flex !important;
  align-items: center;
  justify-content: space-between;
  gap: 0.4rem;
}

.sidebar__workspace span,
.sidebar__session span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sidebar__session span {
  font-size: 0.82rem;
}

.sidebar__session-list {
  min-height: 0;
  overflow: auto;
  display: grid;
  gap: 0;
  padding-right: 0;
  align-content: start;
}

.is-active {
  background: transparent;
  border-left-color: var(--color-border-accent);
  color: var(--color-text-strong);
}

.sidebar__spinner {
  flex-shrink: 0;
  animation: sidebar-spin 0.85s linear infinite;
}

@keyframes sidebar-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 900px) {
  .sidebar {
    position: fixed;
    z-index: 20;
    inset: var(--safe-area-top) auto var(--safe-area-bottom) var(--safe-area-left);
    transform: translateX(calc(-100% - 0.6rem));
    transition: transform 0.2s ease;
    max-width: min(17rem, calc(100vw - var(--safe-area-left) - var(--safe-area-right) - 0.6rem));
    height: auto;
    border-right: 0;
    box-shadow: var(--color-shadow-mobile);
  }

  .sidebar--open {
    transform: translateX(0);
  }

  .sidebar__close {
    display: block;
  }
}
</style>
