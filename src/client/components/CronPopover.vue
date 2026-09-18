<script setup lang="ts">
import { PanelRightOpen, Square } from "@lucide/vue";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import CronJobCard from "@/client/components/CronJobCard.vue";
import FullPopover from "@/client/components/FullPopover.vue";
import SubagentSessionPopover from "@/client/components/SubagentSessionPopover.vue";
import { useCronJobDrafts } from "@/client/composables/useCronJobDrafts";
import { listRunningSubagents } from "@/client/lib/api";
import { useAppStore } from "@/client/stores/app";
import type { CronRunLog, RunningSubagent } from "@/shared/types";

const props = defineProps<{
  popoverId: string;
  anchorName: string;
}>();

type Tab = "jobs" | "logs" | "subagents";

const store = useAppStore();
const activeTab = ref<Tab>("jobs");
const stoppingRunIds = ref(new Set<string>());
const runningSubagents = ref<RunningSubagent[]>([]);
const subagentError = ref("");
let subagentLoadGeneration = 0;
let subagentPoll: ReturnType<typeof setInterval> | undefined;
const {
  jobs,
  draftFor,
  editJob,
  cancelEdit,
  setDraftModel,
  thinkingOptions,
  sessionLabel,
  saveJob,
  toggleJob,
  deleteJob,
} = useCronJobDrafts(store);
const runLogs = computed(() => {
  const runningById = new Map(store.workspaceRunningCronJobs.map((run) => [run.runId, run]));
  return store.workspaceCronRunLogs.map((run) => ({ ...run, ...runningById.get(run.runId) }));
});

function runPopoverId(runId: string): string {
  return `cron-run-popover-${runId.replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
}

function subagentPopoverId(sessionId: string): string {
  return `running-subagent-popover-${sessionId.replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
}

function tabId(tab: Tab): string {
  return `${props.popoverId}-${tab}-tab`;
}

function panelId(tab: Tab): string {
  return `${props.popoverId}-${tab}-panel`;
}

function handleTabKeydown(event: KeyboardEvent): void {
  const tabs: Tab[] = ["jobs", "logs", "subagents"];
  const currentIndex = tabs.indexOf(activeTab.value);
  const nextIndex =
    event.key === "ArrowRight"
      ? (currentIndex + 1) % tabs.length
      : event.key === "ArrowLeft"
        ? (currentIndex - 1 + tabs.length) % tabs.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? tabs.length - 1
            : undefined;
  if (nextIndex === undefined) return;
  event.preventDefault();
  activeTab.value = tabs[nextIndex]!;
  document.getElementById(tabId(activeTab.value))?.focus();
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

function refreshModels(): void {
  void store.refreshModels();
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

async function refreshRunningSubagents(): Promise<void> {
  const parentSessionId = store.activeSession?.sessionId;
  const generation = ++subagentLoadGeneration;
  if (!parentSessionId) {
    runningSubagents.value = [];
    subagentError.value = "";
    return;
  }

  try {
    const subagents = await listRunningSubagents(parentSessionId);
    if (
      generation !== subagentLoadGeneration ||
      store.activeSession?.sessionId !== parentSessionId
    ) {
      return;
    }
    runningSubagents.value = subagents;
    subagentError.value = "";
  } catch (error) {
    if (generation === subagentLoadGeneration) {
      subagentError.value = error instanceof Error ? error.message : String(error);
    }
  }
}

function handlePopoverToggle(event: Event): void {
  const isOpen = (event as ToggleEvent).newState === "open";
  if (subagentPoll) {
    clearInterval(subagentPoll);
    subagentPoll = undefined;
  }
  if (isOpen) {
    if (activeTab.value === "subagents") void refreshRunningSubagents();
    subagentPoll = setInterval(() => {
      if (activeTab.value === "subagents") void refreshRunningSubagents();
    }, 1_500);
  }
}

watch(activeTab, (tab) => {
  if (tab === "subagents") void refreshRunningSubagents();
});

watch(
  () => store.activeSession?.sessionId,
  () => {
    runningSubagents.value = [];
    subagentError.value = "";
    if (activeTab.value === "subagents") void refreshRunningSubagents();
  },
);

watch(
  () => store.selectedWorkspaceId,
  (workspaceId) => {
    if (workspaceId) {
      void store.loadWorkspaceCronJobs(workspaceId);
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  subagentLoadGeneration += 1;
  if (subagentPoll) clearInterval(subagentPoll);
});
</script>

<template>
  <FullPopover
    class="cron-popover"
    :popover-id="props.popoverId"
    :anchor-name="props.anchorName"
    title="Cron and subagents"
    :subtitle="`Current workspace: ${store.selectedWorkspace?.label ?? ''}`"
    close-label="Close cron and subagents popover"
    @toggle="handlePopoverToggle"
  >
    <template #header-content>
      <div class="cron-popover__tabs" role="tablist" aria-label="Cron and subagent views">
        <button
          :id="tabId('jobs')"
          type="button"
          role="tab"
          :aria-selected="activeTab === 'jobs'"
          :aria-controls="panelId('jobs')"
          :tabindex="activeTab === 'jobs' ? 0 : -1"
          class="cron-popover__tab"
          @click="activeTab = 'jobs'"
          @keydown="handleTabKeydown"
        >
          Jobs
        </button>
        <button
          :id="tabId('logs')"
          type="button"
          role="tab"
          :aria-selected="activeTab === 'logs'"
          :aria-controls="panelId('logs')"
          :tabindex="activeTab === 'logs' ? 0 : -1"
          class="cron-popover__tab"
          @click="activeTab = 'logs'"
          @keydown="handleTabKeydown"
        >
          Logs
          <span
            v-if="runLogs.some((run) => run.status === 'running')"
            class="cron-popover__live-dot"
          />
        </button>
        <button
          :id="tabId('subagents')"
          type="button"
          role="tab"
          :aria-selected="activeTab === 'subagents'"
          :aria-controls="panelId('subagents')"
          :tabindex="activeTab === 'subagents' ? 0 : -1"
          class="cron-popover__tab"
          @click="activeTab = 'subagents'"
          @keydown="handleTabKeydown"
        >
          Subagents
          <span v-if="runningSubagents.length > 0" class="cron-popover__live-dot" />
        </button>
      </div>
    </template>

    <div class="cron-popover__body">
      <div
        v-if="activeTab === 'jobs'"
        :id="panelId('jobs')"
        class="cron-popover__pane"
        role="tabpanel"
        :aria-labelledby="tabId('jobs')"
      >
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
          @model-change="setDraftModel(job, $event)"
          @refresh-models="refreshModels"
          @save="saveJob(job)"
          @toggle="toggleJob(job)"
          @delete="deleteJob(job)"
        />

        <div v-if="jobs.length === 0" class="cron-popover__empty">
          No cron jobs in this workspace yet. Create them with the <code>cron</code> tool or the
          <code>batty cron</code> CLI.
        </div>
      </div>

      <div
        v-else-if="activeTab === 'logs'"
        :id="panelId('logs')"
        class="cron-popover__pane"
        role="tabpanel"
        :aria-labelledby="tabId('logs')"
      >
        <article v-for="run in runLogs" :key="run.runId" class="cron-popover__run">
          <div class="cron-popover__run-content">
            <div class="cron-popover__run-heading">
              <span class="cron-popover__status">{{ statusLabel(run) }}</span>
              <strong>{{ run.scheduleLabel }}</strong>
            </div>
            <div class="cron-popover__run-prompt">{{ run.prompt }}</div>
            <div class="cron-popover__run-details">
              <span>{{ formatTimestamp(run.startedAtMs) }}</span>
              <span v-if="formatDuration(run.durationMs)">{{
                formatDuration(run.durationMs)
              }}</span>
              <span>{{ run.session.kind }}</span>
            </div>
            <div v-if="run.error" class="cron-popover__run-error">{{ run.error }}</div>
          </div>
          <div class="cron-popover__run-actions">
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
            <button
              v-if="run.sessionPath || run.status === 'running'"
              type="button"
              class="cron-popover__icon-btn"
              :disabled="!run.sessionPath"
              :popovertarget="run.sessionPath ? runPopoverId(run.runId) : undefined"
              aria-label="Open cron run session"
              :title="run.sessionPath ? 'Open session' : 'Session is starting'"
            >
              <PanelRightOpen :size="16" />
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

      <div
        v-else
        :id="panelId('subagents')"
        class="cron-popover__pane"
        role="tabpanel"
        :aria-labelledby="tabId('subagents')"
      >
        <article
          v-for="subagent in runningSubagents"
          :key="subagent.sessionId"
          class="cron-popover__run"
        >
          <div class="cron-popover__run-content">
            <div class="cron-popover__run-heading">
              <span class="cron-popover__status">Running</span>
              <strong>{{ subagent.model }} · {{ subagent.thinkingLevel }}</strong>
            </div>
            <div class="cron-popover__run-prompt">{{ subagent.prompt }}</div>
            <div class="cron-popover__run-details">
              <span>{{ formatTimestamp(subagent.startedAtMs) }}</span>
              <span>{{ subagent.sessionId }}</span>
            </div>
          </div>
          <div class="cron-popover__run-actions">
            <button
              type="button"
              class="cron-popover__icon-btn"
              :popovertarget="subagentPopoverId(subagent.sessionId)"
              aria-label="Open subagent session"
              title="Open session"
            >
              <PanelRightOpen :size="16" />
            </button>
          </div>
          <SubagentSessionPopover
            :popover-id="subagentPopoverId(subagent.sessionId)"
            header-title="Subagent"
            :workspace-id="subagent.workspaceId"
            :session-path="subagent.sessionPath"
          />
        </article>

        <div v-if="subagentError" class="cron-popover__empty cron-popover__empty--error">
          {{ subagentError }}
        </div>
        <div v-else-if="runningSubagents.length === 0" class="cron-popover__empty">
          No subagents are running for this session.
        </div>
      </div>
    </div>
  </FullPopover>
</template>

<style scoped>
.cron-popover {
  background: var(--color-bg-panel-strong);
}

.cron-popover__body {
  height: 100%;
  min-height: 0;
  background: var(--color-bg-app);
}

.cron-popover :deep(.full-popover__header) {
  border-bottom: 0;
  background: var(--color-bg-panel-strong);
}

.cron-popover__tabs {
  display: flex;
  gap: 0.25rem;
  margin-bottom: -0.75rem;
  background: transparent;
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
  height: 100%;
  min-height: 0;
  flex-direction: column;
  overflow-y: auto;
}

.cron-popover__run {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  background: transparent;
}

.cron-popover__run:not(:last-of-type) {
  border-bottom: 1px solid var(--color-border-soft);
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

.cron-popover__empty--error {
  color: var(--color-error);
}

.cron-popover__empty code {
  font-family: var(--font-family-mono);
}
</style>
