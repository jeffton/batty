<script setup lang="ts">
import { computed, onUnmounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import ChatSessionPane from "@/client/components/ChatSessionPane.vue";
import WorkspaceBrowserPane from "@/client/components/WorkspaceBrowserPane.vue";
import { workspaceRoutePath } from "@/client/lib/routes";
import { useAppStore } from "@/client/stores/app";

type PaneRoute = "browser" | "session" | undefined;
type PaneTransition = "" | "slide-from-right" | "slide-from-left";

const store = useAppStore();
const route = useRoute();
const router = useRouter();
const transitionName = ref<PaneTransition>("");

const isWorkspaceBrowserRoute = computed(() => route.name !== "session");

function paneForRouteName(name: unknown): PaneRoute {
  if (name === "session") {
    return "session";
  }

  if (name === "home" || name === "workspace") {
    return "browser";
  }

  return undefined;
}

function transitionForNavigation(toName: unknown, fromName: unknown): PaneTransition {
  const toPane = paneForRouteName(toName);
  const fromPane = paneForRouteName(fromName);

  if (!toPane || !fromPane || toPane === fromPane) {
    return "";
  }

  if (fromPane === "browser" && toPane === "session") {
    return "slide-from-right";
  }

  if (fromPane === "session" && toPane === "browser") {
    return "slide-from-left";
  }

  return "";
}

function clearTransitionSoon(): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      transitionName.value = "";
    });
  });
}

const removeBeforeEach = router.beforeEach((to, from) => {
  transitionName.value = transitionForNavigation(to.name, from.name);
});

const removeAfterEach = router.afterEach(() => {
  clearTransitionSoon();
});

function normalizedHistoryPath(path: string | undefined): string {
  return (path ?? "").split("#", 1)[0]?.split("?", 1)[0] ?? "";
}

async function goBackToWorkspaceBrowser(): Promise<void> {
  const workspaceId =
    typeof route.params.workspaceId === "string"
      ? route.params.workspaceId
      : (store.activeSession?.workspaceId ?? store.selectedWorkspaceId);
  if (!workspaceId) {
    return;
  }

  const targetPath = workspaceRoutePath(workspaceId);
  const backPath =
    typeof window.history.state?.back === "string"
      ? normalizedHistoryPath(window.history.state.back)
      : "";

  if (backPath === targetPath) {
    await router.back();
    return;
  }

  transitionName.value = "slide-from-left";
  await router.push(targetPath);
}

onUnmounted(() => {
  removeBeforeEach();
  removeAfterEach();
});
</script>

<template>
  <main class="chat-shell">
    <Transition :name="transitionName">
      <WorkspaceBrowserPane v-show="isWorkspaceBrowserRoute" class="chat-shell__pane" />
    </Transition>

    <Transition :name="transitionName">
      <ChatSessionPane
        v-show="!isWorkspaceBrowserRoute"
        class="chat-shell__pane"
        @back="goBackToWorkspaceBrowser"
      />
    </Transition>
  </main>
</template>

<style scoped>
.chat-shell {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--color-bg-app);
}

.chat-shell__pane {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  min-height: 0;
}

.slide-from-right-enter-active,
.slide-from-right-leave-active,
.slide-from-left-enter-active,
.slide-from-left-leave-active {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  transition: transform 0.25s ease-out;
}

.slide-from-right-enter-from {
  transform: translateX(100%);
}

.slide-from-right-leave-to {
  transform: translateX(-30%);
}

.slide-from-left-enter-from {
  transform: translateX(-30%);
}

.slide-from-left-leave-to {
  transform: translateX(100%);
}

.slide-from-right-enter-to,
.slide-from-right-leave-from,
.slide-from-left-enter-to,
.slide-from-left-leave-from {
  transform: translateX(0);
}

@media (prefers-reduced-motion: reduce) {
  .slide-from-right-enter-active,
  .slide-from-right-leave-active,
  .slide-from-left-enter-active,
  .slide-from-left-leave-active {
    transition-duration: 0.01ms;
  }
}
</style>
