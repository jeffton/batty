<script setup lang="ts">
import { onMounted, onUnmounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  NOTIFICATION_NAVIGATION_MESSAGE_TYPE,
  notificationPathFromUrl,
} from "@/client/lib/notification-navigation";
import { readCachedSession } from "@/client/lib/cache";
import { workspaceRoutePath } from "@/client/lib/routes";
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
const onServiceWorkerMessage = (event: MessageEvent<unknown>) => {
  if (
    !event.data ||
    typeof event.data !== "object" ||
    !("type" in event.data) ||
    !("url" in event.data) ||
    event.data.type !== NOTIFICATION_NAVIGATION_MESSAGE_TYPE ||
    typeof event.data.url !== "string"
  ) {
    return;
  }

  const targetPath = notificationPathFromUrl(event.data.url);
  if (!targetPath) {
    return;
  }

  pendingNotificationPath = targetPath;
  void syncRouteToStore();
};

let syncVersion = 0;
let pendingNotificationPath: string | undefined;

const WORKSPACES_ROUTE = "/";

async function hydrateRouteFromCache(
  workspaceId: string,
  sessionId?: string,
  shouldSelect: () => boolean = () => true,
): Promise<boolean> {
  if (!sessionId || !shouldSelect()) {
    return true;
  }

  const activeSessionMatches =
    store.activeSession?.workspaceId === workspaceId && store.activeSession.sessionId === sessionId;
  if (activeSessionMatches) {
    return true;
  }

  const cached = await readCachedSession(sessionId);
  if (!shouldSelect()) {
    return true;
  }
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

  if (pendingNotificationPath && route.fullPath !== pendingNotificationPath) {
    store.clearRouteLoading();
    const targetPath = pendingNotificationPath;
    pendingNotificationPath = undefined;
    await router.replace(targetPath);
    return;
  }

  if (pendingNotificationPath === route.fullPath) {
    pendingNotificationPath = undefined;
  }

  if (route.path === "/login") {
    store.clearRouteLoading();
    await router.replace(WORKSPACES_ROUTE);
    return;
  }

  const routeWorkspaceId =
    typeof route.params.workspaceId === "string" ? route.params.workspaceId : undefined;
  if (
    routeWorkspaceId &&
    !store.workspaces.some((workspace) => workspace.id === routeWorkspaceId)
  ) {
    store.clearRouteLoading();
    await router.replace(WORKSPACES_ROUTE);
    return;
  }

  const workspaceId = routeWorkspaceId ?? store.selectedWorkspaceId ?? store.workspaces[0]?.id;
  const sessionId = typeof route.params.sessionId === "string" ? route.params.sessionId : undefined;
  const routeIsOffline = () =>
    (sessionId ? store.connectionState : store.workspaceConnectionState) === "offline";

  if (!workspaceId) {
    store.clearRouteLoading();
    return;
  }

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

    if (routeIsOffline()) {
      const hydrated = await hydrateRouteFromCache(
        workspaceId,
        sessionId,
        () => version === syncVersion,
      );
      if (!hydrated) {
        await router.replace(workspaceRoutePath(workspaceId));
      }
      return;
    }

    try {
      if (sessionId) {
        void store.loadWorkspaceSessions(workspaceId).catch((error) => {
          if (!navigator.onLine || routeIsOffline()) {
            store.markOffline();
            return;
          }
          console.error("Failed to load workspace sessions", error);
        });
        await store.loadWorkspaceCronJobs(workspaceId);
      } else {
        await Promise.all([
          store.loadWorkspaceSessions(workspaceId),
          store.loadWorkspaceCronJobs(workspaceId),
        ]);
      }
    } catch (error) {
      if (!navigator.onLine || routeIsOffline()) {
        store.markOffline();
        const hydrated = await hydrateRouteFromCache(
          workspaceId,
          sessionId,
          () => version === syncVersion,
        );
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
      return;
    }

    const activeSessionMatches =
      store.activeSession?.workspaceId === workspaceId &&
      store.activeSession.sessionId === sessionId;
    const shouldSelect = () => version === syncVersion;
    if (activeSessionMatches) {
      store.openStream(store.activeSession!);
      return;
    }

    try {
      await store.resumeSessionById(workspaceId, sessionId, { shouldSelect });
    } catch {
      if (!shouldSelect()) {
        return;
      }
      const hydrated = await hydrateRouteFromCache(workspaceId, sessionId, shouldSelect);
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
  navigator.serviceWorker?.addEventListener("message", onServiceWorkerMessage);
  await store.bootstrap();
});

onUnmounted(() => {
  window.removeEventListener("offline", handleOffline);
  window.removeEventListener("online", onOnline);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  navigator.serviceWorker?.removeEventListener("message", onServiceWorkerMessage);
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
