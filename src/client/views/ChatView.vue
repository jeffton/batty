<script setup lang="ts">
import { useRoute, useRouter } from "vue-router";
import ChatSessionPane from "@/client/components/ChatSessionPane.vue";
import WorkspaceBrowserPane from "@/client/components/WorkspaceBrowserPane.vue";
import { workspaceRoutePath } from "@/client/lib/routes";
import { useAppStore } from "@/client/stores/app";

const store = useAppStore();
const route = useRoute();
const router = useRouter();

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

  await router.push(targetPath);
}
</script>

<template>
  <main class="chat-shell">
    <WorkspaceBrowserPane class="chat-shell__browser" />
    <ChatSessionPane class="chat-shell__session" @back="goBackToWorkspaceBrowser" />
  </main>
</template>

<style scoped>
.chat-shell {
  display: grid;
  grid-template-columns: minmax(20rem, 24rem) minmax(0, 1fr);
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--color-bg-app);
}

.chat-shell__browser,
.chat-shell__session {
  min-width: 0;
  min-height: 0;
}

.chat-shell__session {
  border-left: 1px solid var(--color-border-soft);
}
</style>
