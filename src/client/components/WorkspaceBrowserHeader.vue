<script setup lang="ts">
import { Cog, LoaderCircle, Wifi, WifiOff } from "lucide-vue-next";
import SettingsPopover from "@/client/components/SettingsPopover.vue";

const props = defineProps<{
  popoverId: string;
  popoverAnchor: string;
  connectionState: "online" | "connecting" | "offline";
  connectionDescription: string;
}>();

const emit = defineEmits<{
  logout: [];
}>();
</script>

<template>
  <header class="workspace-browser-header">
    <div class="workspace-browser-header__brand">
      <img src="/favicon.png" alt="Batty" class="workspace-browser-header__brand-icon" />
      <div class="workspace-browser-header__brand-copy">
        <h1>Batty</h1>
      </div>
    </div>

    <div class="workspace-browser-header__actions">
      <span
        class="workspace-browser-header__status"
        :aria-label="props.connectionDescription"
        :title="props.connectionDescription"
      >
        <Wifi
          v-if="props.connectionState === 'online'"
          :size="15"
          class="workspace-browser-header__status-icon workspace-browser-header__status-icon--online"
        />
        <LoaderCircle
          v-else-if="props.connectionState === 'connecting'"
          :size="15"
          class="workspace-browser-header__status-icon workspace-browser-header__status-icon--spin"
        />
        <WifiOff
          v-else
          :size="15"
          class="workspace-browser-header__status-icon workspace-browser-header__status-icon--offline"
        />
      </span>

      <button
        class="workspace-browser-header__btn"
        type="button"
        :style="{ 'anchor-name': props.popoverAnchor }"
        :popovertarget="props.popoverId"
        aria-label="Settings"
        title="Settings"
      >
        <Cog :size="16" />
      </button>

      <SettingsPopover
        :popover-id="props.popoverId"
        :anchor-name="props.popoverAnchor"
        @logout="emit('logout')"
      />
    </div>
  </header>
</template>

<style scoped>
.workspace-browser-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: calc(var(--safe-area-top) + 0.9rem) calc(var(--safe-area-right) + 1rem) 0.9rem
    calc(var(--safe-area-left) + 1rem);
  border-bottom: 1px solid var(--color-border-soft);
  background: var(--color-bg-panel);
}

.workspace-browser-header__brand {
  display: flex;
  align-items: center;
  gap: 0.8rem;
  min-width: 0;
}

.workspace-browser-header__brand-icon {
  width: 2.4rem;
  height: 2.4rem;
  border-radius: 0.65rem;
  flex-shrink: 0;
}

.workspace-browser-header__brand-copy {
  min-width: 0;
}

.workspace-browser-header__brand-copy h1 {
  margin: 0;
  font-size: 1.2rem;
  line-height: 1.1;
  color: var(--color-text-strong);
}

.workspace-browser-header__actions {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-shrink: 0;
}

.workspace-browser-header__status,
.workspace-browser-header__status-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.workspace-browser-header__status-icon--online {
  color: var(--color-success);
}

.workspace-browser-header__status-icon--offline {
  color: var(--color-warning);
}

.workspace-browser-header__status-icon--spin {
  color: var(--color-text-subtle);
  animation: workspace-browser-header-spin 0.85s linear infinite;
}

.workspace-browser-header__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 0.55rem;
  background: transparent;
  color: var(--color-text-muted);
  padding: 0.45rem;
  transition:
    background 80ms ease,
    color 80ms ease;
}

@media (hover: hover) {
  .workspace-browser-header__btn:hover {
    background: var(--color-bg-elevated);
    color: var(--color-text-strong);
  }
}

@keyframes workspace-browser-header-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
