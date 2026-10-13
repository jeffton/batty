<script setup lang="ts">
import { PanelRightOpen } from "@lucide/vue";
import { onBeforeUnmount, ref } from "vue";
import FullPopover from "./FullPopover.vue";
import PopoverTabs from "./PopoverTabs.vue";
import SubagentSessionPopover from "./SubagentSessionPopover.vue";
import { listWorkspaceCronJobs, listWorkspaceCronRunLogs } from "@/client/lib/api";
import { useAppStore } from "@/client/stores/app";
import type { CronJob, CronRunLog } from "@/shared/types";

const props = defineProps<{ popoverId: string; anchorName: string }>();
const store = useAppStore();
const tabs = ["cron", "logs"] as const;
type Tab = (typeof tabs)[number];
const activeTab = ref<string>("cron");
const jobs = ref<CronJob[]>([]);
const logs = ref<CronRunLog[]>([]);
const error = ref("");
const loading = ref(false);
let open = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;

function tabId(tab: Tab) {
  return `${props.popoverId}-${tab}-tab`;
}
function panelId(tab: Tab) {
  return `${props.popoverId}-${tab}-panel`;
}
function sessionPopoverId(kind: "worker" | "cron", id: string) {
  return `${props.popoverId}-${kind}-${id}`;
}
function workspaceLabel(id: string) {
  return store.workspaces.find((workspace) => workspace.id === id)?.label ?? id;
}
function formatTimestamp(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}
function statusLabel(status: CronRunLog["status"]) {
  return status === "running" ? "Running" : status === "success" ? "Completed" : "Failed";
}
async function refresh() {
  clearTimeout(timer);
  const request = ++generation;
  loading.value = true;
  try {
    const workspaceData = await Promise.all(
      store.workspaces.map(async (workspace) => ({
        jobs: await listWorkspaceCronJobs(workspace.id),
        logs: await listWorkspaceCronRunLogs(workspace.id),
      })),
    );
    if (request !== generation) return;
    jobs.value = workspaceData.flatMap((data) => data.jobs);
    logs.value = workspaceData
      .flatMap((data) => data.logs)
      .sort((a, b) => b.startedAtMs - a.startedAtMs);
    error.value = "";
  } catch (cause) {
    if (request === generation)
      error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (request === generation) {
      loading.value = false;
      if (open) timer = setTimeout(() => void refresh(), 3000);
    }
  }
}
function toggle(event: Event) {
  open = (event as ToggleEvent).newState === "open";
  clearTimeout(timer);
  if (open) void refresh();
  else {
    generation++;
    loading.value = false;
  }
}
onBeforeUnmount(() => {
  open = false;
  generation++;
  clearTimeout(timer);
});
</script>

<template>
  <FullPopover
    class="cron-popover"
    :popover-id="props.popoverId"
    :anchor-name="props.anchorName"
    title="Cron"
    subtitle="Cron jobs and logs across all workspaces"
    close-label="Close cron popover"
    @toggle="toggle"
  >
    <template #header-content>
      <PopoverTabs v-model="activeTab" :id-prefix="props.popoverId" label="Cron views" :tabs="tabs">
        <template #default="{ tab }">
          {{ tab === "cron" ? "Cron" : "Logs" }}
          <span
            v-if="tab === 'logs' && logs.some((run) => run.status === 'running')"
            class="cron-popover__live-dot"
          />
        </template>
      </PopoverTabs>
    </template>
    <div class="cron-popover__body">
      <p v-if="error" role="alert" class="cron-popover__error">{{ error }}</p>
      <p v-if="loading && !jobs.length && !logs.length" class="cron-popover__empty">Loading…</p>
      <div
        v-for="tab in tabs"
        v-show="activeTab === tab"
        :id="panelId(tab)"
        :key="tab"
        class="cron-popover__pane"
        role="tabpanel"
        :aria-labelledby="tabId(tab)"
        tabindex="0"
      >
        <template v-if="tab === 'cron'">
          <article v-for="job in jobs" :key="job.id" class="cron-popover__run">
            <div class="cron-popover__run-content">
              <div class="cron-popover__run-heading">
                <span class="cron-popover__status">{{ job.enabled ? "Enabled" : "Paused" }}</span>
                <strong>{{ job.scheduleLabel }}</strong>
              </div>
              <div class="cron-popover__run-prompt">{{ job.prompt }}</div>
              <div class="cron-popover__run-details">
                <span>{{ workspaceLabel(job.workspaceId) }}</span>
                <span>{{ job.model }} · {{ job.thinkingLevel }}</span>
                <span>Delivery: {{ job.delivery === "direct" ? "Direct" : "Via assistant" }}</span>
                <span v-if="job.state.nextRunAtMs"
                  >Next: {{ formatTimestamp(job.state.nextRunAtMs) }}</span
                >
              </div>
            </div>
          </article>
          <div v-if="!loading && !jobs.length" class="cron-popover__empty">
            No scheduled cron jobs.
          </div>
        </template>
        <template v-else>
          <template v-for="run in logs" :key="run.runId">
            <component
              :is="run.sessionId ? 'button' : 'article'"
              class="cron-popover__run"
              :type="run.sessionId ? 'button' : undefined"
              :popovertarget="run.sessionId ? sessionPopoverId('cron', run.runId) : undefined"
              :aria-label="run.sessionId ? `Open cron run session: ${run.prompt}` : undefined"
            >
              <span class="cron-popover__run-content">
                <span class="cron-popover__run-heading">
                  <span class="cron-popover__status">{{ statusLabel(run.status) }}</span>
                  <strong>{{ run.scheduleLabel }}</strong>
                </span>
                <span class="cron-popover__run-prompt">{{ run.prompt }}</span>
                <span class="cron-popover__run-details">
                  <span>{{ workspaceLabel(run.workspaceId) }}</span>
                  <span>{{ formatTimestamp(run.startedAtMs) }}</span>
                  <span v-if="run.durationMs != null"
                    >{{ Math.round(run.durationMs / 1000) }} sec</span
                  >
                </span>
                <span v-if="run.error" class="cron-popover__error">{{ run.error }}</span>
              </span>
              <PanelRightOpen
                v-if="run.sessionId"
                class="cron-popover__open"
                :size="16"
                aria-hidden="true"
              />
            </component>
            <SubagentSessionPopover
              v-if="run.sessionId"
              :popover-id="sessionPopoverId('cron', run.runId)"
              :session-id="run.sessionId"
              header-title="Cron run"
            />
          </template>
          <div v-if="!loading && !logs.length" class="cron-popover__empty">
            No cron runs have been logged yet.
          </div>
        </template>
      </div>
    </div>
  </FullPopover>
</template>

<style scoped>
.cron-popover__body {
  display: flex;
  height: 100%;
  min-height: 0;
  flex-direction: column;
  background: var(--color-bg-app);
}
.cron-popover__live-dot {
  width: 0.45rem;
  height: 0.45rem;
  border-radius: 50%;
  background: var(--color-success);
}
.cron-popover__pane {
  min-height: 0;
  flex: 1;
  overflow-y: auto;
}
.cron-popover__run {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  min-height: 44px;
  width: 100%;
  padding: 0.75rem 1rem;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
}
button.cron-popover__run {
  cursor: pointer;
}
button.cron-popover__run:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}
@media (hover: hover) {
  button.cron-popover__run:hover {
    background: var(--color-bg-elevated-soft);
  }
}
.cron-popover__run ~ .cron-popover__run {
  border-top: 1px solid var(--color-border-soft);
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
.cron-popover__run-heading strong,
.cron-popover__run-prompt {
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
  font-size: 0.84rem;
}
.cron-popover__run-details {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 0.75rem;
  color: var(--color-text-subtle);
  font-size: 0.74rem;
  overflow-wrap: anywhere;
}
.cron-popover__open {
  flex: 0 0 auto;
  color: var(--color-text);
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
.cron-popover__error {
  margin: 0;
  padding: 0.5rem 1rem;
  color: var(--color-error);
  font-size: 0.85rem;
  overflow-wrap: anywhere;
}
</style>
