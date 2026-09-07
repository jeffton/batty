<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import ChatSessionPane from "@/client/components/ChatSessionPane.vue";
import WorkspaceBrowserPane from "@/client/components/WorkspaceBrowserPane.vue";
import {
  clearPaneTransition,
  consumePaneTransition,
  startPaneTransition,
} from "@/client/lib/pane-transition";
import { workspaceRoutePath } from "@/client/lib/routes";
import { useAppStore } from "@/client/stores/app";

const store = useAppStore();
const route = useRoute();
const router = useRouter();
const isPaneTransitioning = ref(false);

const isWorkspaceBrowserRoute = computed(() => route.name !== "session");

watch(
  () => (isWorkspaceBrowserRoute.value ? "browser" : "session"),
  (pane) => {
    // Native history swipes already animate; only app controls opt into a slide.
    isPaneTransitioning.value = consumePaneTransition(pane);
  },
  { flush: "sync" },
);

function clearPaneTransitionAnimation(event?: TransitionEvent): void {
  if (event && (event.target !== event.currentTarget || event.propertyName !== "transform")) {
    return;
  }

  isPaneTransitioning.value = false;
}

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

  startPaneTransition("browser");
  if (backPath === targetPath) {
    router.back();
    return;
  }

  try {
    await router.push(targetPath);
  } finally {
    clearPaneTransition();
  }
}
</script>

<template>
  <main class="chat-shell">
    <WorkspaceBrowserPane
      :class="[
        'chat-shell__pane',
        'chat-shell__pane--browser',
        {
          'chat-shell__pane--active': isWorkspaceBrowserRoute,
          'chat-shell__pane--transitioning': isPaneTransitioning,
        },
      ]"
      :inert="!isWorkspaceBrowserRoute"
      :aria-hidden="!isWorkspaceBrowserRoute"
      @transitionend="clearPaneTransitionAnimation"
    />

    <ChatSessionPane
      :class="[
        'chat-shell__pane',
        'chat-shell__pane--session',
        {
          'chat-shell__pane--active': !isWorkspaceBrowserRoute,
          'chat-shell__pane--transitioning': isPaneTransitioning,
        },
      ]"
      :inert="isWorkspaceBrowserRoute"
      :aria-hidden="isWorkspaceBrowserRoute"
      @back="goBackToWorkspaceBrowser"
      @transitionend="clearPaneTransitionAnimation"
    />
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
  pointer-events: none;
}

.chat-shell__pane--browser {
  z-index: 0;
  transform: translateX(-30%);
}

.chat-shell__pane--session {
  z-index: 1;
  transform: translateX(100%);
}

.chat-shell__pane--active {
  pointer-events: auto;
  transform: translateX(0);
}

.chat-shell__pane--transitioning {
  transition: transform 0.25s ease-out;
}

@media (prefers-reduced-motion: reduce) {
  .chat-shell__pane--transitioning {
    transition-duration: 0.01ms;
  }
}
</style>
