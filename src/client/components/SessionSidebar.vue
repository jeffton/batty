<script setup lang="ts">
import { computed, onMounted, watch } from "vue";
import { useAppStore } from "@/client/stores/app";

const store = useAppStore();
const workspaces = computed(() => store.workspaces);
const sessions = computed(() => store.workspaceSessions);

watch(
  () => store.selectedWorkspaceId,
  async (workspaceId) => {
    if (workspaceId) {
      await store.loadWorkspaceSessions(workspaceId);
    }
  },
  { immediate: true },
);

onMounted(async () => {
  if (store.selectedWorkspaceId) {
    await store.loadWorkspaceSessions(store.selectedWorkspaceId);
  }
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

    <section class="sidebar__section">
      <div class="sidebar__section-title">Recent sessions</div>
      <button
        v-for="session in sessions"
        :key="session.id"
        class="sidebar__session"
        @click="store.resumeSession(session.workspaceId, session.path || session.id)"
      >
        <strong>{{ session.name || session.firstMessage || "Untitled session" }}</strong>
        <span class="muted">{{ new Date(session.updatedAt).toLocaleString() }}</span>
      </button>
      <div v-if="sessions.length === 0" class="muted">No sessions yet.</div>
    </section>
  </aside>
</template>

<style scoped>
.sidebar {
  width: min(100vw, 22rem);
  padding: 1rem;
  display: grid;
  gap: 1rem;
  grid-template-rows: auto auto 1fr;
  height: 100%;
}

.sidebar__header {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
}

.sidebar__header h1 {
  margin: 0;
}

.sidebar__header p {
  margin: 0.35rem 0 0;
}

.sidebar__close {
  display: none;
  border: 0;
  background: transparent;
  color: #e2e8f0;
  font-size: 1.25rem;
}

.sidebar__section {
  display: grid;
  gap: 0.65rem;
}

.sidebar__section-title {
  font-size: 0.85rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #94a3b8;
}

.sidebar__workspace,
.sidebar__session,
.sidebar__action {
  width: 100%;
  text-align: left;
  border-radius: 0.9rem;
  border: 1px solid rgba(148, 163, 184, 0.15);
  background: rgba(15, 23, 42, 0.85);
  color: inherit;
  padding: 0.85rem;
  display: grid;
  gap: 0.25rem;
}

.is-active {
  border-color: rgba(96, 165, 250, 0.8);
  box-shadow: 0 0 0 1px rgba(96, 165, 250, 0.15);
}

.sidebar__action {
  background: rgba(37, 99, 235, 0.18);
}

@media (max-width: 900px) {
  .sidebar {
    position: fixed;
    z-index: 20;
    inset: 0 auto 0 0;
    transform: translateX(-105%);
    transition: transform 0.2s ease;
    max-width: 85vw;
  }

  .sidebar--open {
    transform: translateX(0);
  }

  .sidebar__close {
    display: block;
  }
}
</style>
