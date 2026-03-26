<script setup lang="ts">
import { onMounted, onUnmounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { readCachedSession } from "@/client/lib/cache";
import { sessionRoutePath, workspaceRoutePath } from "@/client/lib/routes";
import { useAppStore } from "@/client/stores/app";

const store = useAppStore();
const route = useRoute();
const router = useRouter();

const handleOffline = () => store.markOffline();
const handleOnline = async () => {
  store.markOnline();
  await store.checkForClientUpdate();
};
const handleVisibilityChange = async () => {
  if (document.visibilityState === "visible" && navigator.onLine) {
    await store.checkForClientUpdate();
  }
};
const onOnline = () => {
  void handleOnline();
};
const onVisibilityChange = () => {
  void handleVisibilityChange();
};

let syncVersion = 0;

function fallbackWorkspaceRoute(): string | undefined {
  const recentSession = store.mostRecentSessionSummary;
  if (
    recentSession &&
    store.workspaces.some((workspace) => workspace.id === recentSession.workspaceId)
  ) {
    return sessionRoutePath(recentSession.workspaceId, recentSession.sessionId);
  }

  const workspaceId = store.selectedWorkspaceId ?? store.workspaces[0]?.id;
  return workspaceId ? workspaceRoutePath(workspaceId) : undefined;
}

async function hydrateRouteFromCache(workspaceId: string, sessionId?: string): Promise<boolean> {
  if (!sessionId) {
    if (store.activeSession) {
      store.clearActiveSession();
    }
    return true;
  }

  const activeSessionMatches =
    store.activeSession?.workspaceId === workspaceId && store.activeSession.sessionId === sessionId;
  if (activeSessionMatches) {
    return true;
  }

  const cached = await readCachedSession(sessionId);
  if (!cached || cached.workspaceId !== workspaceId) {
    store.clearActiveSession();
    return false;
  }

  await store.selectSession(cached, { openStream: false });
  return true;
}

async function syncRouteToStore(): Promise<void> {
  const version = ++syncVersion;

  if (!store.bootstrapped) {
    return;
  }

  if (!store.authenticated) {
    store.clearRouteLoading();
    if (route.path !== "/login") {
      await router.replace("/login");
    }
    return;
  }

  if (route.path === "/login") {
    store.clearRouteLoading();
    const fallback = fallbackWorkspaceRoute();
    if (fallback) {
      await router.replace(fallback);
    }
    return;
  }

  const workspaceId =
    typeof route.params.workspaceId === "string" ? route.params.workspaceId : undefined;
  if (!workspaceId) {
    store.clearRouteLoading();
    const fallback = fallbackWorkspaceRoute();
    if (fallback) {
      await router.replace(fallback);
    }
    return;
  }

  if (!store.workspaces.some((workspace) => workspace.id === workspaceId)) {
    store.clearRouteLoading();
    const fallback = fallbackWorkspaceRoute();
    if (fallback) {
      await router.replace(fallback);
    }
    return;
  }

  const sessionId = typeof route.params.sessionId === "string" ? route.params.sessionId : undefined;
  store.setRouteLoading(workspaceId, sessionId);

  try {
    if (store.selectedWorkspaceId !== workspaceId) {
      store.selectWorkspace(workspaceId);
    }

    const activeSessionMatchesTarget =
      sessionId != null &&
      store.activeSession?.workspaceId === workspaceId &&
      store.activeSession.sessionId === sessionId;
    if (sessionId && !activeSessionMatchesTarget && store.activeSession) {
      store.clearActiveSession();
    }

    if (store.connectionState === "offline") {
      const hydrated = await hydrateRouteFromCache(workspaceId, sessionId);
      if (!hydrated) {
        await router.replace(workspaceRoutePath(workspaceId));
      }
      return;
    }

    try {
      await Promise.all([
        store.loadWorkspaceSessions(workspaceId),
        store.loadWorkspaceCronJobs(workspaceId),
      ]);
    } catch (error) {
      if (!navigator.onLine || store.connectionState === "offline") {
        store.markOffline();
        const hydrated = await hydrateRouteFromCache(workspaceId, sessionId);
        if (!hydrated) {
          await router.replace(workspaceRoutePath(workspaceId));
        }
        return;
      }

      throw error;
    }

    if (version !== syncVersion) {
      return;
    }

    if (!sessionId) {
      if (store.activeSession) {
        store.clearActiveSession();
      }
      return;
    }

    const activeSessionMatches =
      store.activeSession?.workspaceId === workspaceId &&
      store.activeSession.sessionId === sessionId;
    if (activeSessionMatches) {
      return;
    }

    const session = (store.sessionsByWorkspace[workspaceId] ?? []).find(
      (candidate) => candidate.sessionId === sessionId,
    );
    if (!session?.path) {
      const hydrated = await hydrateRouteFromCache(workspaceId, sessionId);
      if (!hydrated) {
        await router.replace(workspaceRoutePath(workspaceId));
      }
      return;
    }

    try {
      await store.resumeSession(workspaceId, session.path);
    } catch {
      const hydrated = await hydrateRouteFromCache(workspaceId, sessionId);
      if (!hydrated) {
        await router.replace(workspaceRoutePath(workspaceId));
      }
    }
  } finally {
    if (version === syncVersion) {
      store.clearRouteLoading();
    }
  }
}

onMounted(async () => {
  window.addEventListener("offline", handleOffline);
  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisibilityChange);
  await store.bootstrap();
});

onUnmounted(() => {
  window.removeEventListener("offline", handleOffline);
  window.removeEventListener("online", onOnline);
  document.removeEventListener("visibilitychange", onVisibilityChange);
});

watch(
  () => ({
    bootstrapped: store.bootstrapped,
    authenticated: store.authenticated,
    path: route.fullPath,
  }),
  () => {
    void syncRouteToStore();
  },
  { immediate: true },
);
</script>

<template>
  <div class="app-shell">
    <div v-if="!store.bootstrapped" class="center-panel">
      <div class="spinner" />
      <p>Booting Batty…</p>
    </div>
    <RouterView v-else />
  </div>
</template>
