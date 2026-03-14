<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import type { SessionSummary } from "@/shared/types";
import { useAppStore } from "@/client/stores/app";

const store = useAppStore();
const workspaces = computed(() => store.workspaces);
const sessions = computed(() => store.workspaceSessions);
const sessionList = ref<HTMLElement>();

function sessionLabel(session: SessionSummary): string {
  return (session.name || session.firstMessage || "Untitled session").replace(/\s+/g, " ").trim();
}

async function scrollSessionsToBottom(): Promise<void> {
  await nextTick();
  const element = sessionList.value;
  if (!element) {
    return;
  }
  element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
}

watch(
  () => store.selectedWorkspaceId,
  async (workspaceId) => {
    if (workspaceId) {
      await store.loadWorkspaceSessions(workspaceId);
    }
  },
  { immediate: true },
);

watch(
  () => ({
    workspaceId: store.selectedWorkspaceId,
    activeSessionId: store.activeSession?.sessionId,
    sessionCount: sessions.value.length,
    lastSessionId: sessions.value.at(-1)?.id,
    sidebarOpen: store.mobileSidebarOpen,
  }),
  () => {
    void scrollSessionsToBottom();
  },
  { immediate: true },
);

onMounted(() => {
  void scrollSessionsToBottom();
});
</script>

<template>
  <aside :class="['sidebar panel', store.mobileSidebarOpen ? 'sidebar--open' : '']">
    <div class="sidebar__header">
      <div>
        <h1>pi-face</h1>
        <p class="muted">Pi Coding Agent, but browser-y.</p>
      </div>
      <button class="sidebar__close" @click="store.mobileSidebarOpen = false">✕</button>
    </div>

    <section class="sidebar__section">
      <div class="sidebar__section-title">Workspaces</div>
      <button
        v-for="workspace in workspaces"
        :key="workspace.id"
        :class="[
          'sidebar__workspace',
          workspace.id === store.selectedWorkspaceId ? 'is-active' : '',
        ]"
        @click="store.selectWorkspace(workspace.id)"
      >
        <strong>{{ workspace.label }}</strong>
        <span class="muted">{{ workspace.kind === "self" ? "self" : workspace.path }}</span>
      </button>
      <button
        v-if="store.selectedWorkspaceId"
        class="sidebar__action"
        @click="store.startSession(store.selectedWorkspaceId)"
      >
        + New session
      </button>
    </section>

    <section class="sidebar__section sidebar__section--sessions">
      <div class="sidebar__section-title">Recent sessions</div>
      <div ref="sessionList" class="sidebar__session-list">
        <button
          v-for="session in sessions"
          :key="session.id"
          :class="[
            'sidebar__session',
            session.sessionId === store.activeSession?.sessionId ? 'is-active' : '',
          ]"
          @click="store.resumeSession(session.workspaceId, session.path || session.id)"
        >
          <strong class="sidebar__session-title">{{ sessionLabel(session) }}</strong>
          <span class="muted">{{ new Date(session.updatedAt).toLocaleString() }}</span>
        </button>
        <div v-if="sessions.length === 0" class="muted">No sessions yet.</div>
      </div>
    </section>
  </aside>
</template>

<style scoped>
.sidebar {
  width: min(100vw, 19rem);
  height: 100%;
  min-height: 0;
  padding: 0.75rem;
  display: grid;
  gap: 0.75rem;
  grid-template-rows: auto auto minmax(0, 1fr);
  overflow: hidden;
}

.sidebar__header {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
}

.sidebar__header h1,
.sidebar__header p {
  margin: 0;
}

.sidebar__header h1 {
  font-size: 1.1rem;
}

.sidebar__header p {
  margin-top: 0.25rem;
}

.sidebar__close {
  display: none;
  border: 0;
  background: transparent;
  color: #e5e7eb;
  font-size: 1.1rem;
}

.sidebar__section {
  display: grid;
  gap: 0.5rem;
}

.sidebar__section--sessions {
  min-height: 0;
  grid-template-rows: auto minmax(0, 1fr);
}

.sidebar__section-title {
  font-size: 0.78rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #98a2ad;
}

.sidebar__workspace,
.sidebar__session,
.sidebar__action {
  width: 100%;
  text-align: left;
  border-radius: 0.6rem;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(22, 27, 34, 0.92);
  color: inherit;
  padding: 0.7rem 0.75rem;
  display: grid;
  gap: 0.2rem;
}

.sidebar__workspace strong,
.sidebar__session-title {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sidebar__workspace span,
.sidebar__session span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sidebar__session-list {
  min-height: 0;
  overflow: auto;
  display: grid;
  gap: 0.5rem;
  padding-right: 0.15rem;
}

.is-active {
  border-color: rgba(255, 255, 255, 0.18);
  background: rgba(33, 38, 45, 0.98);
}

.sidebar__action {
  background: rgba(46, 160, 67, 0.12);
}

@media (max-width: 900px) {
  .sidebar {
    position: fixed;
    z-index: 20;
    inset: 0.5rem auto 0.5rem 0.5rem;
    transform: translateX(calc(-100% - 0.75rem));
    transition: transform 0.2s ease;
    max-width: min(19rem, calc(100vw - 1rem));
    height: auto;
  }

  .sidebar--open {
    transform: translateX(0);
  }

  .sidebar__close {
    display: block;
  }
}
</style>
