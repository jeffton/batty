<script setup lang="ts">
import { PanelRightOpen, Square, X } from "@lucide/vue";
import CronJobCard from "@/client/components/CronJobCard.vue";
import SubagentSessionPopover from "@/client/components/SubagentSessionPopover.vue";
import { useCronJobDrafts } from "@/client/composables/useCronJobDrafts";
import { useAppStore } from "@/client/stores/app";
import type { CronRunLog } from "@/shared/types";
import { computed, ref, watch } from "vue";

const props = defineProps<{
  popoverId: string;
  anchorName: string;
}>();

const store = useAppStore();
const popoverElement = ref<HTMLElement | null>(null);
const activeTab = ref<"jobs" | "logs">("jobs");
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
const runLogs = computed(() => store.workspaceCronRunLogs);

function runPopoverId(runId: string): string {
  return `cron-run-popover-${runId.replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
}

function statusLabel(run: CronRunLog): string {
  if (run.status === "running") return "Running";
  return run.status === "success" ? "Completed" : "Failed";
}

function formatTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

function formatDuration(durationMs?: number): string | undefined {
  if (durationMs == null) return undefined;
  if (durationMs < 1_000) return `${durationMs} ms`;
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)} sec`;
  return `${Math.round(durationMs / 60_000)} min`;
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
    ref="popoverElement"
    class="cron-popover"
    :style="{ 'position-anchor': props.anchorName }"
    popover="auto"
  >
    <div class="cron-popover__header">
      <div>
        <div class="cron-popover__title">Cron</div>
        <div class="cron-popover__subtitle">
          Current workspace: {{ store.selectedWorkspace?.label }}
        </div>
      </div>
      <button
        type="button"
        class="cron-popover__close"
        aria-label="Close cron popover"
        title="Close"
        @click="popoverElement?.hidePopover?.()"
      >
        <X :size="16" />
      </button>
    </div>

    <div class="cron-popover__tabs" role="tablist" aria-label="Cron views">
      <button
        type="button"
        role="tab"
        :aria-selected="activeTab === 'jobs'"
        :tabindex="activeTab === 'jobs' ? 0 : -1"
        class="cron-popover__tab"
        @click="activeTab = 'jobs'"
      >
        Jobs
      </button>
      <button
        type="button"
        role="tab"
        :aria-selected="activeTab === 'logs'"
        :tabindex="activeTab === 'logs' ? 0 : -1"
        class="cron-popover__tab"
        @click="activeTab = 'logs'"
      >
        Logs
        <span
          v-if="runLogs.some((run) => run.status === 'running')"
          class="cron-popover__live-dot"
        />
      </button>
    </div>

    <div v-if="activeTab === 'jobs'" class="cron-popover__pane" role="tabpanel">
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

    <div v-else class="cron-popover__pane" role="tabpanel">
      <article
        v-for="run in runLogs"
        :key="run.runId"
        class="cron-popover__run"
        :class="`cron-popover__run--${run.status}`"
      >
        <div class="cron-popover__run-content">
          <div class="cron-popover__run-heading">
            <span class="cron-popover__status">{{ statusLabel(run) }}</span>
            <strong>{{ run.scheduleLabel }}</strong>
          </div>
          <div class="cron-popover__run-prompt">{{ run.prompt }}</div>
          <div class="cron-popover__run-details">
            <span>{{ formatTimestamp(run.startedAtMs) }}</span>
            <span v-if="formatDuration(run.durationMs)">{{ formatDuration(run.durationMs) }}</span>
            <span>{{ run.session.kind }}</span>
          </div>
          <div v-if="run.error" class="cron-popover__run-error">{{ run.error }}</div>
        </div>
        <div class="cron-popover__run-actions">
          <button
            v-if="run.sessionPath"
            type="button"
            class="cron-popover__icon-btn"
            :popovertarget="runPopoverId(run.runId)"
            aria-label="Open cron run session"
            title="Open session"
          >
            <PanelRightOpen :size="16" />
          </button>
          <button
            v-if="run.status === 'running'"
            type="button"
            class="cron-popover__icon-btn cron-popover__icon-btn--danger"
            :disabled="stoppingRunIds.has(run.runId)"
            aria-label="Stop cron run"
            title="Stop run"
            @click.stop.prevent="stopRun(run.runId)"
          >
            <Square :size="14" />
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

      <div v-if="runLogs.length === 0" class="cron-popover__empty">
        No cron runs have been logged in this workspace yet.
      </div>
    </div>
  </div>
</template>

<style scoped>
.cron-popover {
  inset: calc(var(--safe-area-top) + 1rem) calc(var(--safe-area-right) + 1rem)
    calc(var(--safe-area-bottom) + 1rem) calc(var(--safe-area-left) + 1rem);
  width: auto;
  max-width: none;
  height: auto;
  max-height: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--color-border-soft);
  border-radius: 0.9rem;
  background: var(--color-bg-panel);
  color: var(--color-text);
  box-shadow: var(--color-shadow-popover);
  overflow: hidden;
  overscroll-behavior: contain;
}

.cron-popover:popover-open {
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
}

.cron-popover::backdrop {
  background: rgb(0 0 0 / 0.22);
}

.cron-popover__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.9rem 1rem 0.75rem;
  background: var(--color-bg-panel-strong);
}

.cron-popover__title {
  font-size: 1rem;
  font-weight: 700;
  color: var(--color-text-strong);
}

.cron-popover__subtitle {
  font-size: 0.78rem;
  color: var(--color-text-subtle);
}

.cron-popover__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  padding: 0;
  border: 1px solid var(--color-border-soft);
  border-radius: 0.5rem;
  background: var(--color-bg-panel);
  color: var(--color-text);
  cursor: pointer;
}

@media (hover: hover) {
  .cron-popover__close:hover {
    background: var(--color-bg-elevated-soft);
  }
}

.cron-popover__tabs {
  display: flex;
  gap: 0.25rem;
  padding: 0 1rem;
  border-bottom: 1px solid var(--color-border-soft);
  background: var(--color-bg-panel-strong);
}

.cron-popover__tab {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.65rem 0.8rem 0.55rem;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--color-text-subtle);
  font: inherit;
  font-size: 0.86rem;
  font-weight: 650;
  cursor: pointer;
}

.cron-popover__tab[aria-selected="true"] {
  border-bottom-color: var(--color-accent);
  color: var(--color-text-strong);
}

.cron-popover__live-dot {
  width: 0.45rem;
  height: 0.45rem;
  border-radius: 50%;
  background: var(--color-success);
}

.cron-popover__pane {
  display: flex;
  min-height: 0;
  flex-direction: column;
  gap: 0.6rem;
  padding: 0.75rem 1rem 1rem;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.cron-popover__run {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.75rem;
  border: 1px solid var(--color-border-soft);
  border-left-width: 3px;
  border-radius: 0.65rem;
  background: var(--color-bg-panel-strong);
}

.cron-popover__run--running {
  border-left-color: var(--color-accent);
}

.cron-popover__run--success {
  border-left-color: var(--color-success);
}

.cron-popover__run--error {
  border-left-color: var(--color-error);
}

.cron-popover__run-content {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 0.25rem;
}

.cron-popover__run-heading {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  font-size: 0.84rem;
}

.cron-popover__run-heading strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cron-popover__status {
  flex: 0 0 auto;
  color: var(--color-text-subtle);
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.cron-popover__run-prompt {
  overflow: hidden;
  color: var(--color-text);
  font-size: 0.84rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cron-popover__run-details {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 0.75rem;
  color: var(--color-text-subtle);
  font-size: 0.74rem;
}

.cron-popover__run-error {
  color: var(--color-error);
  font-size: 0.78rem;
}

.cron-popover__run-actions {
  display: flex;
  flex: 0 0 auto;
  gap: 0.35rem;
}

.cron-popover__icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  padding: 0;
  border: 1px solid var(--color-border-soft);
  border-radius: 0.5rem;
  background: var(--color-bg-panel);
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
  display: flex;
  min-height: 10rem;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  color: var(--color-text-subtle);
  font-size: 0.85rem;
  text-align: center;
}

.cron-popover__empty code {
  font-family: var(--font-family-mono);
}
</style>
