<script setup lang="ts">
import { computed, onUnmounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import ChatSessionPane from "@/client/components/ChatSessionPane.vue";
import WorkspaceBrowserPane from "@/client/components/WorkspaceBrowserPane.vue";
import { usePaneTransition } from "@/client/lib/pane-transition";
import { workspaceRoutePath } from "@/client/lib/routes";
import { useAppStore } from "@/client/stores/app";

const store = useAppStore();
const route = useRoute();
const router = useRouter();
const { paneTransitionName, setPaneTransition, clearPaneTransitionSoon } = usePaneTransition();

const isWorkspaceBrowserRoute = computed(() => route.name !== "session");

const removeAfterEach = router.afterEach(() => {
  clearPaneTransitionSoon();
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

  setPaneTransition("slide-from-left");
  await router.push(targetPath);
}

onUnmounted(() => {
  removeAfterEach();
});
</script>

<template>
  <main class="chat-shell">
    <Transition :name="paneTransitionName">
      <WorkspaceBrowserPane v-show="isWorkspaceBrowserRoute" class="chat-shell__pane" />
    </Transition>

    <Transition :name="paneTransitionName">
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
