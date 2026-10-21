<script setup lang="ts">
import { Wrench, Clock3 } from "@lucide/vue";
import { useAppStore } from "@/client/stores/app";
import { withBaseUrl } from "@/client/lib/base-url";
import SettingsPopover from "./SettingsPopover.vue";
import ToolsPopover from "./ToolsPopover.vue";
import CronPopover from "./CronPopover.vue";
import SessionHeaderStatus from "./SessionHeaderStatus.vue";
import ProviderUsageIndicator from "./ProviderUsageIndicator.vue";
const store = useAppStore();
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
        class="header__button"
        popovertarget="settings-popover"
        aria-label="Settings"
        title="Settings"
      >
        <img :src="withBaseUrl('/favicon.png')" alt="" />
      </button>
    </div>
    <button
      type="button"
      class="header__button"
      popovertarget="workers-popover"
      aria-label="Cron"
      title="Cron"
    >
      <Clock3 :size="17" />
    </button>
    <button
      type="button"
      class="header__button"
      popovertarget="tools-popover"
      aria-label="Workspaces and tools"
      title="Workspaces and tools"
    >
      <Wrench :size="17" />
    </button>
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
  background: var(--color-bg-panel-strong);
  border-bottom: 1px solid var(--color-border-soft);
  box-shadow: var(--color-shadow-header);
}
.header__brand {
  display: flex;
  align-items: center;
}
.header__brand img {
  width: 1.6rem;
  height: 1.6rem;
  border-radius: 0.35rem;
}
.header__button {
  display: grid;
  place-items: center;
  flex: 0 0 44px;
  width: 44px;
  height: 44px;
  padding: 0;
  border: 0;
  border-radius: 0.5rem;
  background: transparent;
  color: var(--color-text-subtle);
}
.header__button:hover {
  background: var(--color-bg-elevated);
}
.header__button:focus-visible {
  outline: 2px solid var(--color-text-subtle);
  outline-offset: -2px;
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
