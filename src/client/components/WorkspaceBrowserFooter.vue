<script setup lang="ts">
import { CalendarDays, LoaderCircle } from "lucide-vue-next";

const props = defineProps<{
  assistantWorkspaceLabel: string;
  actionsDisabled: boolean;
  startingDailySession: boolean;
}>();

const emit = defineEmits<{
  openTodaySession: [];
}>();
</script>

<template>
  <footer class="workspace-browser-footer">
    <button
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
      <span v-if="props.startingDailySession">Opening…</span>
      <span v-else>
        Today in <strong>{{ props.assistantWorkspaceLabel }}</strong>
      </span>
    </button>
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
  width: 100%;
  border: 0;
  border-radius: 0.6rem;
  background: transparent;
  color: var(--color-text-muted);
  padding: 0.7rem 0.9rem;
  font-weight: 600;
  transition:
    background 80ms ease,
    color 80ms ease;
}

.workspace-browser-footer__btn--assistant {
  justify-content: flex-start;
}

@media (hover: hover) {
  .workspace-browser-footer__btn:hover:not(:disabled) {
    background: var(--color-bg-hover);
    color: var(--color-text-strong);
  }
}

.workspace-browser-footer__btn:disabled {
  opacity: 0.55;
  cursor: default;
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
