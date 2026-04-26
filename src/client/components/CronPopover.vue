<script setup lang="ts">
import CronJobCard from "@/client/components/CronJobCard.vue";
import { useCronJobDrafts } from "@/client/composables/useCronJobDrafts";
import { useAppStore } from "@/client/stores/app";
import { watch } from "vue";

const props = defineProps<{
  popoverId: string;
  anchorName: string;
}>();

const store = useAppStore();
const { jobs, draftFor, editJob, cancelEdit, thinkingOptions, sessionLabel, saveJob, deleteJob } =
  useCronJobDrafts(store);

watch(
  () => store.selectedWorkspaceId,
  (workspaceId) => {
    if (workspaceId) {
      void store.loadWorkspaceCronJobs(workspaceId);
    }
  },
  { immediate: true },
);
</script>

<template>
  <div
    :id="props.popoverId"
    class="cron-popover"
    :style="{ 'position-anchor': props.anchorName }"
    popover="auto"
  >
    <div class="cron-popover__header">
      <div>
        <div class="cron-popover__title">Cron jobs</div>
        <div class="cron-popover__subtitle">
          Current workspace: {{ store.selectedWorkspace?.label }}
        </div>
      </div>
    </div>

    <div class="cron-popover__jobs">
      <CronJobCard
        v-for="job in jobs"
        :key="job.id"
        :job="job"
        :draft="draftFor(job)"
        :models="store.models"
        :session-label="sessionLabel(job)"
        :thinking-options="thinkingOptions(job)"
        @edit="editJob(job)"
        @cancel="cancelEdit(job)"
        @save="saveJob(job)"
        @delete="deleteJob(job)"
      />

      <div v-if="jobs.length === 0" class="cron-popover__empty">
        No cron jobs in this workspace yet. Create them with the <code>cron</code> tool or the
        <code>batty cron</code> CLI.
      </div>
    </div>
  </div>
</template>

<style scoped>
.cron-popover {
  display: none;
}

.cron-popover:popover-open {
  position: fixed;
  position-area: block-end span-inline-start;
  position-try-fallbacks:
    block-end span-inline-end,
    block-start span-inline-start,
    block-start span-inline-end;
  width: min(34rem, calc(100vw - var(--safe-area-left) - var(--safe-area-right) - 1rem));
  max-width: calc(100vw - var(--safe-area-left) - var(--safe-area-right) - 1rem);
  max-height: min(32rem, calc(100dvh - var(--safe-area-top) - var(--safe-area-bottom) - 4rem));
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0.6rem;
  border: 1px solid var(--color-border-soft);
  border-radius: 0.75rem;
  background: var(--color-bg-overlay);
  color: inherit;
  box-shadow: var(--color-shadow-popover);
  gap: 0.5rem;
}

.cron-popover::backdrop {
  background: var(--color-backdrop);
}

.cron-popover__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0 0.2rem;
}

.cron-popover__title {
  font-size: 0.9rem;
  font-weight: 700;
  color: var(--color-text-strong);
}

.cron-popover__subtitle {
  font-size: 0.78rem;
  color: var(--color-text-subtle);
}

.cron-popover__jobs {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  min-height: 0;
  overflow-y: auto;
}

.cron-popover__empty {
  padding: 1rem 0.4rem;
  color: var(--color-text-subtle);
  font-size: 0.85rem;
}

.cron-popover__empty code {
  font-family: var(--font-family-mono);
}
</style>
