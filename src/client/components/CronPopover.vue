<script setup lang="ts">
import { PanelRightOpen } from "@lucide/vue";
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

type Tab = "jobs" | "subagents" | "logs";

type ActivityLog =
  | ({ kind: "cron" } & CronRunLog)
  | {
      kind: "subagent";
      id: string;
      workspaceId: string;
      sessionPath: string;
      prompt: string;
      model: string;
      thinkingLevel: string;
      timestamp: number;
      status: "running" | "success" | "error";
    };

interface SubagentDetails {
  prompt?: unknown;
  model?: unknown;
  effort?: unknown;
  workspaceId?: unknown;
  sessionId?: unknown;
  sessionPath?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
}

const store = useAppStore();
const activeTab = ref<Tab>("jobs");
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
const activityLogs = computed<ActivityLog[]>(() => {
  const runningById = new Map(
    runningSubagents.value.map((subagent) => [subagent.sessionId, subagent]),
  );
  const subagents = new Map<string, Extract<ActivityLog, { kind: "subagent" }>>();
  const toolStartedAt = new Map<string, number>();

  for (const message of store.activeSession?.messages ?? []) {
    if (message.role === "assistant") {
      for (const block of message.blocks) {
        if (block.type === "toolCall" && block.name === "subagent") {
          toolStartedAt.set(block.id, message.timestamp);
        }
      }
      continue;
    }

    let details: SubagentDetails | undefined;
    let failed = false;
    let startedAt = message.timestamp;
    if (message.role === "toolResult" && message.toolName === "subagent") {
      details = message.details?.subagent as SubagentDetails | undefined;
      failed = message.isError;
      startedAt = toolStartedAt.get(message.toolCallId) ?? startedAt;
    } else if (message.role === "custom") {
      details = message.data?.subagent as SubagentDetails | undefined;
    }
    if (
      !details ||
      typeof details.sessionId !== "string" ||
      typeof details.sessionPath !== "string" ||
      typeof details.workspaceId !== "string"
    ) {
      continue;
    }

    const existing = subagents.get(details.sessionId);
    subagents.set(details.sessionId, {
      kind: "subagent",
      id: details.sessionId,
      workspaceId: details.workspaceId,
      sessionPath: details.sessionPath,
      prompt:
        typeof details.prompt === "string" ? details.prompt : (existing?.prompt ?? "Subagent"),
      model:
        typeof details.model === "string" ? details.model : (existing?.model ?? "Unknown model"),
      thinkingLevel:
        typeof details.effort === "string" ? details.effort : (existing?.thinkingLevel ?? "off"),
      timestamp: existing?.timestamp ?? startedAt,
      status:
        failed ||
        details.errorMessage ||
        details.stopReason === "error" ||
        details.stopReason === "aborted"
          ? "error"
          : runningById.has(details.sessionId)
            ? "running"
            : "success",
    });
  }

  for (const subagent of runningSubagents.value) {
    subagents.set(subagent.sessionId, {
      kind: "subagent",
      id: subagent.sessionId,
      workspaceId: subagent.workspaceId,
      sessionPath: subagent.sessionPath,
      prompt: subagent.prompt,
      model: subagent.model,
      thinkingLevel: subagent.thinkingLevel,
      timestamp: subagent.startedAtMs,
      status: "running",
    });
  }

  return [
    ...runLogs.value.map((run): ActivityLog => ({ kind: "cron", ...run })),
    ...subagents.values(),
  ].sort((left, right) => {
    const leftTimestamp = left.kind === "cron" ? left.startedAtMs : left.timestamp;
    const rightTimestamp = right.kind === "cron" ? right.startedAtMs : right.timestamp;
    return rightTimestamp - leftTimestamp;
  });
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
  const tabs: Tab[] = ["jobs", "subagents", "logs"];
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

function statusLabel(status: "running" | "success" | "error"): string {
  if (status === "running") return "Running";
  return status === "success" ? "Completed" : "Failed";
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
    if (activeTab.value !== "jobs") void refreshRunningSubagents();
    subagentPoll = setInterval(() => {
      if (activeTab.value !== "jobs") void refreshRunningSubagents();
    }, 1_500);
  }
}

watch(activeTab, (tab) => {
  if (tab !== "jobs") void refreshRunningSubagents();
});

watch(
  () => store.activeSession?.sessionId,
  () => {
    runningSubagents.value = [];
    subagentError.value = "";
    if (activeTab.value !== "jobs") void refreshRunningSubagents();
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
            v-if="activityLogs.some((entry) => entry.status === 'running')"
            class="cron-popover__live-dot"
          />
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
        <article
          v-for="entry in activityLogs"
          :key="entry.kind === 'cron' ? `cron-${entry.runId}` : `subagent-${entry.id}`"
          class="cron-popover__run"
        >
          <div class="cron-popover__run-content">
            <div class="cron-popover__run-heading">
              <span class="cron-popover__status">{{ statusLabel(entry.status) }}</span>
              <strong>{{ entry.kind === "cron" ? entry.scheduleLabel : "Subagent" }}</strong>
            </div>
            <div class="cron-popover__run-prompt">{{ entry.prompt }}</div>
            <div class="cron-popover__run-details">
              <span>{{
                formatTimestamp(entry.kind === "cron" ? entry.startedAtMs : entry.timestamp)
              }}</span>
              <template v-if="entry.kind === 'cron'">
                <span v-if="formatDuration(entry.durationMs)">{{
                  formatDuration(entry.durationMs)
                }}</span>
                <span>{{ entry.session.kind }}</span>
              </template>
              <template v-else>
                <span>{{ entry.model }}</span>
                <span>{{ entry.thinkingLevel }}</span>
              </template>
            </div>
            <div v-if="entry.kind === 'cron' && entry.error" class="cron-popover__run-error">
              {{ entry.error }}
            </div>
          </div>
          <div class="cron-popover__run-actions">
            <button
              v-if="entry.kind === 'subagent' || entry.sessionPath || entry.status === 'running'"
              type="button"
              class="cron-popover__icon-btn"
              :disabled="entry.kind === 'cron' && !entry.sessionPath"
              :popovertarget="
                entry.kind === 'subagent'
                  ? subagentPopoverId(entry.id)
                  : entry.sessionPath
                    ? runPopoverId(entry.runId)
                    : undefined
              "
              :aria-label="
                entry.kind === 'cron' ? 'Open cron run session' : 'Open subagent session'
              "
              :title="
                entry.kind === 'cron' && !entry.sessionPath ? 'Session is starting' : 'Open session'
              "
            >
              <PanelRightOpen :size="16" />
            </button>
          </div>
          <SubagentSessionPopover
            v-if="entry.kind === 'subagent' || entry.sessionPath"
            :popover-id="
              entry.kind === 'subagent' ? subagentPopoverId(entry.id) : runPopoverId(entry.runId)
            "
            :header-title="entry.kind === 'cron' ? 'Cron run' : 'Subagent'"
            :workspace-id="entry.workspaceId"
            :session-path="entry.sessionPath!"
          />
        </article>

        <div v-if="activityLogs.length === 0" class="cron-popover__empty">
          No cron or subagent runs have been logged yet.
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
