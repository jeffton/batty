<script setup lang="ts">
import { CalendarDays, Check, EllipsisVertical, LoaderCircle } from "lucide-vue-next";

const props = defineProps<{
  assistantWorkspaceLabel?: string;
  selectedWorkspaceLabel?: string;
  selectedWorkspaceIsAssistant: boolean;
  actionsDisabled: boolean;
  assistantMenuDisabled: boolean;
  startingDailySession: boolean;
  assistantMenuPending: boolean;
  menuPopoverId: string;
  menuPopoverAnchor: string;
}>();

const emit = defineEmits<{
  openTodaySession: [];
  toggleAssistantWorkspace: [];
}>();
</script>

<template>
  <footer class="workspace-browser-footer">
    <button
      v-if="props.assistantWorkspaceLabel"
      class="workspace-browser-footer__btn workspace-browser-footer__btn--assistant"
      type="button"
      :disabled="props.actionsDisabled || props.startingDailySession"
      @click="emit('openTodaySession')"
    >
      <LoaderCircle
        v-if="props.startingDailySession"
        :size="16"
        class="workspace-browser-footer__spinner"
      />
      <CalendarDays v-else :size="16" />
      <span>{{
        props.startingDailySession ? "Opening…" : `Today in ${props.assistantWorkspaceLabel}`
      }}</span>
    </button>

    <div v-else class="workspace-browser-footer__spacer" />

    <button
      class="workspace-browser-footer__btn workspace-browser-footer__btn--icon"
      type="button"
      :style="{ 'anchor-name': props.menuPopoverAnchor }"
      :disabled="props.assistantMenuDisabled"
      :popovertarget="props.menuPopoverId"
      aria-label="Workspace menu"
      title="Workspace menu"
    >
      <EllipsisVertical :size="16" />
    </button>

    <div
      :id="props.menuPopoverId"
      class="workspace-browser-footer__menu"
      popover="auto"
      :style="{ positionAnchor: props.menuPopoverAnchor }"
    >
      <button
        class="workspace-browser-footer__menu-item"
        type="button"
        :disabled="props.assistantMenuPending || !props.selectedWorkspaceLabel"
        @click="emit('toggleAssistantWorkspace')"
      >
        <span class="workspace-browser-footer__menu-icon" aria-hidden="true">
          <Check v-if="props.selectedWorkspaceIsAssistant" :size="15" />
        </span>
        <span v-if="props.selectedWorkspaceLabel">
          Use <strong>{{ props.selectedWorkspaceLabel }}</strong> as assistant
        </span>
      </button>
    </div>
  </footer>
</template>

<style scoped>
.workspace-browser-footer {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.65rem calc(var(--safe-area-right) + 1rem) calc(var(--safe-area-bottom) + 0.65rem)
    calc(var(--safe-area-left) + 1rem);
  border-top: 1px solid var(--color-border-soft);
  background: var(--color-bg-panel);
}

.workspace-browser-footer__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.45rem;
  border: 0;
  border-radius: 0.6rem;
  background: var(--color-bg-elevated);
  color: inherit;
  padding: 0.7rem 0.9rem;
  transition:
    background 80ms ease,
    color 80ms ease;
}

.workspace-browser-footer__btn--assistant {
  flex: 1;
  justify-content: flex-start;
  background: transparent;
  color: var(--color-text-muted);
  font-weight: 600;
}

.workspace-browser-footer__btn--icon {
  flex: 0 0 auto;
  width: 2.75rem;
  padding-inline: 0;
}

@media (hover: hover) {
  .workspace-browser-footer__btn:hover:not(:disabled) {
    background: var(--color-bg-hover);
    color: var(--color-text-strong);
  }
}

.workspace-browser-footer__spacer {
  flex: 1;
}

.workspace-browser-footer__btn:disabled,
.workspace-browser-footer__menu-item:disabled {
  opacity: 0.55;
  cursor: default;
}

.workspace-browser-footer__menu {
  margin: 0;
  inset: auto;
  min-width: 16rem;
  padding: 0.35rem;
  border: 1px solid var(--color-border-soft);
  border-radius: 0.8rem;
  background: var(--color-bg-overlay);
  color: var(--color-text);
  box-shadow: var(--color-shadow-popover);
  position-area: top span-right;
}

.workspace-browser-footer__menu:popover-open {
  display: block;
}

.workspace-browser-footer__menu::backdrop {
  background: transparent;
}

.workspace-browser-footer__menu-item {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  width: 100%;
  border: 0;
  border-radius: 0.55rem;
  background: transparent;
  color: inherit;
  padding: 0.65rem 0.7rem;
  text-align: left;
}

@media (hover: hover) {
  .workspace-browser-footer__menu-item:hover:not(:disabled) {
    background: var(--color-bg-elevated);
  }
}

.workspace-browser-footer__menu-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1rem;
  color: var(--color-accent-strong);
  flex-shrink: 0;
}

.workspace-browser-footer__spinner {
  flex-shrink: 0;
  animation: workspace-browser-footer-spin 0.85s linear infinite;
}

@keyframes workspace-browser-footer-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
