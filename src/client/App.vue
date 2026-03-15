<script setup lang="ts">
import { onMounted, onUnmounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { workspaceRoutePath } from "@/client/lib/routes";
import { useAppStore } from "@/client/stores/app";

const store = useAppStore();
const route = useRoute();
const router = useRouter();

const VERSION_CHECK_INTERVAL_MS = 15000;

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
let versionTimer: ReturnType<typeof window.setInterval> | undefined;
let visualViewport: VisualViewport | null = null;
let viewportListener: (() => void) | null = null;

function isIOSDevice(): boolean {
  const ua = navigator.userAgent;
  const platform = navigator.platform;

  const iosByUa = /iPad|iPhone|iPod/.test(ua);
  const ipadOsDesktopUa = platform === "MacIntel" && navigator.maxTouchPoints > 1;

  return iosByUa || ipadOsDesktopUa;
}

function updateIOSViewportHeight(): void {
  if (!visualViewport) {
    return;
  }

  const viewportHeight = Math.round(visualViewport.height);
  const fullHeight = Math.round(window.innerHeight);
  const keyboardOpen = fullHeight - viewportHeight > 120;

  if (Math.abs(fullHeight - viewportHeight) < 2) {
    document.documentElement.style.removeProperty("--app-height");
  } else {
    document.documentElement.style.setProperty("--app-height", `${viewportHeight}px`);
  }

  document.documentElement.classList.toggle("ios-keyboard-open", keyboardOpen);
  window.scrollTo(0, 0);
}

function fallbackWorkspaceRoute(): string | undefined {
  const workspaceId = store.selectedWorkspaceId ?? store.workspaces[0]?.id;
  return workspaceId ? workspaceRoutePath(workspaceId) : undefined;
}

async function syncRouteToStore(): Promise<void> {
  const version = ++syncVersion;

  if (!store.bootstrapped) {
    return;
  }

  if (!store.authenticated) {
    if (route.path !== "/login") {
      await router.replace("/login");
    }
    return;
  }

  if (route.path === "/login") {
    const fallback = fallbackWorkspaceRoute();
    if (fallback) {
      await router.replace(fallback);
    }
    return;
  }

  const workspaceId =
    typeof route.params.workspaceId === "string" ? route.params.workspaceId : undefined;
  if (!workspaceId) {
    const fallback = fallbackWorkspaceRoute();
    if (fallback) {
      await router.replace(fallback);
    }
    return;
  }

  if (!store.workspaces.some((workspace) => workspace.id === workspaceId)) {
    const fallback = fallbackWorkspaceRoute();
    if (fallback) {
      await router.replace(fallback);
    }
    return;
  }

  if (store.selectedWorkspaceId !== workspaceId) {
    store.selectWorkspace(workspaceId);
  }

  await store.loadWorkspaceSessions(workspaceId);
  if (version !== syncVersion) {
    return;
  }

  const sessionId = typeof route.params.sessionId === "string" ? route.params.sessionId : undefined;
  if (!sessionId) {
    if (store.activeSession) {
      store.clearActiveSession();
    }
    return;
  }

  const activeSessionMatches =
    store.activeSession?.workspaceId === workspaceId && store.activeSession.sessionId === sessionId;
  if (activeSessionMatches) {
    return;
  }

  const session = (store.sessionsByWorkspace[workspaceId] ?? []).find(
    (candidate) => candidate.sessionId === sessionId,
  );
  if (!session?.path) {
    await router.replace(workspaceRoutePath(workspaceId));
    return;
  }

  try {
    await store.resumeSession(workspaceId, session.path);
  } catch {
    await router.replace(workspaceRoutePath(workspaceId));
  }
}

onMounted(async () => {
  window.addEventListener("offline", handleOffline);
  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisibilityChange);

  if (isIOSDevice() && window.visualViewport) {
    visualViewport = window.visualViewport;
    viewportListener = () => {
      updateIOSViewportHeight();
    };

    visualViewport.addEventListener("resize", viewportListener);
    visualViewport.addEventListener("scroll", viewportListener);
    updateIOSViewportHeight();
  }

  await store.bootstrap();
  versionTimer = window.setInterval(() => {
    if (navigator.onLine) {
      void store.checkForClientUpdate();
    }
  }, VERSION_CHECK_INTERVAL_MS);
});

onUnmounted(() => {
  window.removeEventListener("offline", handleOffline);
  window.removeEventListener("online", onOnline);
  document.removeEventListener("visibilitychange", onVisibilityChange);

  if (visualViewport && viewportListener) {
    visualViewport.removeEventListener("resize", viewportListener);
    visualViewport.removeEventListener("scroll", viewportListener);
  }

  document.documentElement.style.removeProperty("--app-height");
  document.documentElement.classList.remove("ios-keyboard-open");

  if (versionTimer) {
    window.clearInterval(versionTimer);
  }
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
      <p>Booting pi-face…</p>
    </div>
    <RouterView v-else />
  </div>
</template>
