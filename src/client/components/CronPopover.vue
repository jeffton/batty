<script setup lang="ts">
import { PanelRightOpen, Square } from "@lucide/vue";
import CronJobCard from "@/client/components/CronJobCard.vue";
import SubagentSessionPopover from "@/client/components/SubagentSessionPopover.vue";
import { useCronJobDrafts } from "@/client/composables/useCronJobDrafts";
import { useAppStore } from "@/client/stores/app";
import { computed, ref, watch } from "vue";

const props = defineProps<{
  popoverId: string;
  anchorName: string;
}>();

const store = useAppStore();
const stoppingRunIds = ref(new Set<string>());
const {
  jobs,
  draftFor,
  editJob,
  cancelEdit,
  thinkingOptions,
  sessionLabel,
  saveJob,
  toggleJob,
  deleteJob,
} = useCronJobDrafts(store);
const runningJobs = computed(() => store.workspaceRunningCronJobs);

function runPopoverId(runId: string): string {
  return `cron-run-popover-${runId.replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
}

async function stopRun(runId: string): Promise<void> {
  stoppingRunIds.value = new Set([...stoppingRunIds.value, runId]);
  try {
    await store.stopCronRun(runId);
  } finally {
    const next = new Set(stoppingRunIds.value);
    next.delete(runId);
    stoppingRunIds.value = next;
  }
}

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

    <div v-if="runningJobs.length > 0" class="cron-popover__running">
      <div class="cron-popover__section-title">Running now</div>
      <article v-for="run in runningJobs" :key="run.runId" class="cron-popover__running-job">
        <div class="cron-popover__running-meta">
          <strong>{{ run.scheduleLabel }}</strong>
          <span>{{ run.prompt }}</span>
        </div>
        <div class="cron-popover__running-actions">
          <button
            v-if="run.sessionPath"
            type="button"
            class="cron-popover__icon-btn"
            :popovertarget="runPopoverId(run.runId)"
          >
            <PanelRightOpen :size="14" />
          </button>
          <button
            type="button"
            class="cron-popover__icon-btn cron-popover__icon-btn--danger"
            :disabled="stoppingRunIds.has(run.runId)"
            @click.stop.prevent="stopRun(run.runId)"
          >
            <Square :size="13" />
          </button>
        </div>
        <SubagentSessionPopover
          v-if="run.sessionPath"
          :popover-id="runPopoverId(run.runId)"
          header-title="Cron run"
          :workspace-id="run.workspaceId"
          :session-path="run.sessionPath"
        />
      </article>
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
        @toggle="toggleJob(job)"
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

.cron-popover__jobs,
.cron-popover__running {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  min-height: 0;
  overflow-y: auto;
}

.cron-popover__running {
  padding-bottom: 0.5rem;
  border-bottom: 1px solid var(--color-border-soft);
  flex: 0 0 auto;
}

.cron-popover__section-title {
  padding: 0 0.2rem;
  font-size: 0.72rem;
  font-weight: 700;
  color: var(--color-text-subtle);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.cron-popover__running-job {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.6rem;
  padding: 0.55rem;
  border: 1px solid var(--color-border-soft);
  border-radius: 0.55rem;
  background: var(--color-bg-panel);
}

.cron-popover__running-meta {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 0.2rem;
  font-size: 0.78rem;
}

.cron-popover__running-meta strong,
.cron-popover__running-meta span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cron-popover__running-actions {
  display: flex;
  flex: 0 0 auto;
  gap: 0.3rem;
}

.cron-popover__icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.75rem;
  height: 1.75rem;
  border: 1px solid var(--color-border-soft);
  border-radius: 0.45rem;
  background: color-mix(in srgb, var(--color-bg-overlay) 86%, transparent);
  color: var(--color-text);
  cursor: pointer;
}

.cron-popover__icon-btn--danger {
  color: var(--color-danger);
}

.cron-popover__icon-btn:disabled {
  cursor: default;
  opacity: 0.5;
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
