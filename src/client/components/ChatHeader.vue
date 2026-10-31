<script setup lang="ts">
import { Wrench, Clock3, Globe } from "@lucide/vue";
import { nextTick, ref } from "vue";
import { openCloudBrowser } from "@/client/lib/api";
import BrowserPopover from "./BrowserPopover.vue";
import type { BrowserDescriptor } from "@/shared/types";
import { useAppStore } from "@/client/stores/app";
import { withBaseUrl } from "@/client/lib/base-url";
import SettingsPopover from "./SettingsPopover.vue";
import ToolsPopover from "./ToolsPopover.vue";
import CronPopover from "./CronPopover.vue";
import SessionHeaderStatus from "./SessionHeaderStatus.vue";
import ProviderUsageIndicator from "./ProviderUsageIndicator.vue";
const store = useAppStore();
const cloudBrowser = ref<BrowserDescriptor>();
const openingBrowser = ref(false);
async function showBrowser(): Promise<void> {
  const workspaceId =
    store.activeSession?.workspaceId ??
    store.workspaces.find((workspace) => workspace.isAssistant)?.id;
  if (!workspaceId || openingBrowser.value) return;
  openingBrowser.value = true;
  try {
    cloudBrowser.value = await openCloudBrowser(workspaceId);
    await nextTick();
    document.getElementById("toolbar-browser")?.showPopover();
  } catch (error) {
    store.lastError = error instanceof Error ? error.message : String(error);
  } finally {
    openingBrowser.value = false;
  }
}
async function logout() {
  try {
    await store.logout();
  } catch (error) {
    store.lastError = error instanceof Error ? error.message : String(error);
  }
}
</script>
<template>
  <header class="header">
    <div class="header__brand">
      <button
        type="button"
        class="header__button chrome-button chrome-button--icon"
        popovertarget="settings-popover"
        aria-label="Settings"
        title="Settings"
      >
        <img :src="withBaseUrl('/favicon.png')" alt="" />
      </button>
    </div>
    <button
      v-if="store.settings.cloudBrowserAvailable"
      type="button"
      class="header__button chrome-button chrome-button--icon"
      aria-label="Open browser"
      title="Open browser"
      :disabled="openingBrowser || !store.workspaces.length"
      :aria-busy="openingBrowser"
      @click="showBrowser"
    >
      <Globe :size="17" />
    </button>
    <button
      type="button"
      class="header__button chrome-button chrome-button--icon"
      popovertarget="workers-popover"
      aria-label="Cron"
      title="Cron"
    >
      <Clock3 :size="17" />
    </button>
    <button
      type="button"
      class="header__button chrome-button chrome-button--icon"
      popovertarget="tools-popover"
      aria-label="Workspaces and tools"
      title="Workspaces and tools"
    >
      <Wrench :size="17" />
    </button>
    <BrowserPopover
      v-if="cloudBrowser"
      :key="cloudBrowser.browserId"
      popover-id="toolbar-browser"
      :browser-id="cloudBrowser.browserId"
      title="Cloud browser"
    />
    <div class="header__spacer" />
    <ProviderUsageIndicator :model="store.activeSession?.model" :update="store.providerUsage" />
    <SessionHeaderStatus
      :context-tokens="store.activeSession?.contextTokens"
      :context-window="store.activeSession?.contextWindow"
      :context-percent="store.activeSession?.contextPercent"
      :connection-state="store.connectionState"
    />
    <SettingsPopover
      popover-id="settings-popover"
      anchor-name="--settings-anchor"
      @logout="logout"
    />
    <ToolsPopover popover-id="tools-popover" anchor-name="--tools-anchor" />
    <CronPopover popover-id="workers-popover" anchor-name="--workers-anchor" />
  </header>
</template>
<style scoped>
.header {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 0.25rem;
  min-width: 0;
  padding: calc(var(--safe-area-top) + 0.5rem) calc(var(--safe-area-right) + 0.65rem) 0.5rem
    calc(var(--safe-area-left) + 0.65rem);
  background: var(--color-chrome-surface);
  border-bottom: 1px solid var(--color-chrome-border);
}
.header__brand {
  display: flex;
  align-items: center;
  margin-right: 0.15rem;
  border-radius: var(--chrome-control-radius);
  background: var(--color-chrome-hover);
}
.header__brand img {
  width: 1.6rem;
  height: 1.6rem;
  border-radius: 0.35rem;
}
.header__button {
  flex: 0 0 var(--button-size);
}
.header__spacer {
  flex: 1;
}
@media (max-width: 360px) {
  .header {
    gap: 2px;
    padding-right: calc(var(--safe-area-right) + 4px);
    padding-left: calc(var(--safe-area-left) + 4px);
  }
}
</style>
