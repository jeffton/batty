<script setup lang="ts">
import { ChevronLeft, LoaderCircle, Clock3 } from "@lucide/vue";
import CronPopover from "@/client/components/CronPopover.vue";
import SessionHeaderStatus from "@/client/components/SessionHeaderStatus.vue";

const props = defineProps<{
  cronPopoverId: string;
  cronPopoverAnchor: string;
  workspaceLabel?: string;
  cwd?: string;
  workspaceSwitcherLoading: boolean;
  selectedWorkspaceId?: string;
  contextTokens?: number;
  contextWindow?: number;
  contextPercent?: number;
  connectionState: "online" | "connecting" | "offline";
}>();

const emit = defineEmits<{
  back: [];
}>();
</script>

<template>
  <header class="header">
    <button
      class="header__ws-btn"
      type="button"
      aria-label="Back to workspaces and sessions"
      @click="emit('back')"
    >
      <ChevronLeft :size="16" class="header__back-icon" />
      <img src="/favicon.png" alt="" class="header__icon" />
      <div class="header__ws-info">
        <span class="header__ws-name">{{ props.workspaceLabel || "Workspaces & sessions" }}</span>
        <span v-if="props.cwd" class="header__ws-path">{{ props.cwd }}</span>
      </div>
      <LoaderCircle
        v-if="props.workspaceSwitcherLoading"
        :size="14"
        class="header__chevron header__status-icon--spin"
      />
    </button>

    <button
      class="header__icon-btn"
      type="button"
      :style="{ 'anchor-name': props.cronPopoverAnchor }"
      :disabled="!props.selectedWorkspaceId"
      :popovertarget="props.cronPopoverId"
      aria-label="Cron jobs"
      title="Cron jobs"
    >
      <Clock3 :size="15" />
    </button>

    <CronPopover :popover-id="props.cronPopoverId" :anchor-name="props.cronPopoverAnchor" />

    <div class="header__spacer" />

    <SessionHeaderStatus
      :context-tokens="props.contextTokens"
      :context-window="props.contextWindow"
      :context-percent="props.contextPercent"
      :connection-state="props.connectionState"
    />
  </header>
</template>

<style scoped>
.header {
  position: relative;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 0.35rem;
  min-width: 0;
  padding: calc(var(--safe-area-top) + 0.4rem) calc(var(--safe-area-right) + 0.6rem) 0.4rem
    calc(var(--safe-area-left) + 0.6rem);
  background: var(--color-bg-panel-strong);
  border-bottom: 1px solid var(--color-border-soft);
  box-shadow: var(--color-shadow-header);
}

.header__icon {
  width: 1.6rem;
  height: 1.6rem;
  border-radius: 0.35rem;
  flex-shrink: 0;
}

.header__ws-btn {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex: 0 1 auto;
  overflow: hidden;
  border: 0;
  border-radius: 0.5rem;
  background: transparent;
  color: inherit;
  padding: 0.3rem 0.45rem;
  min-width: 0;
  text-align: left;
  transition: background 80ms ease;
}

@media (hover: hover) {
  .header__ws-btn:hover {
    background: var(--color-bg-elevated);
  }
}

.header__back-icon {
  color: var(--color-text-subtle);
  flex-shrink: 0;
}

.header__ws-info {
  display: flex;
  flex-direction: column;
  min-width: 0;
  line-height: 1.25;
  text-align: left;
}

.header__ws-name {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--color-text-strong);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header__ws-path {
  font-size: 0.75rem;
  color: var(--color-text-subtle);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header__chevron,
.header__model-caret {
  color: var(--color-text-subtle);
  flex-shrink: 0;
}

.header__model-btn {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex: 0 1 auto;
  overflow: hidden;
  border: 0;
  border-radius: 0.5rem;
  background: transparent;
  color: inherit;
  padding: 0.3rem 0.45rem;
  min-width: 0;
  transition: background 80ms ease;
}

@media (hover: hover) {
  .header__model-btn:hover:not(:disabled) {
    background: var(--color-bg-elevated);
  }
}

.header__model-btn:disabled,
.header__icon-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.header__model-info {
  display: flex;
  flex-direction: column;
  min-width: 0;
  line-height: 1.25;
  text-align: left;
}

.header__icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  border: 0;
  border-radius: 0.5rem;
  background: transparent;
  color: var(--color-text-subtle);
  transition: background 80ms ease;
}

@media (hover: hover) {
  .header__icon-btn:hover:not(:disabled) {
    background: var(--color-bg-elevated);
  }
}

.header__model-name {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--color-text-strong);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header__model-effort {
  font-size: 0.75rem;
  color: var(--color-text-subtle);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header__spacer {
  flex: 1 1 auto;
  min-width: 0;
}

.header__status-icon--spin {
  animation: header-spin 0.9s linear infinite;
}

@keyframes header-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
