<script setup lang="ts">
import { Activity, CircleAlert, PanelRightOpen } from "@lucide/vue";
import { computed, nextTick, ref, useId } from "vue";
import ComposerCountPopover from "./ComposerCountPopover.vue";
import SubagentSessionPopover from "./SubagentSessionPopover.vue";
import type { CronRunLog, RunningSubagent } from "@/shared/types";

const props = defineProps<{
  subagents: RunningSubagent[];
  cronRuns: CronRunLog[];
  memoryPending?: number;
  memoryError?: string;
  compacting?: boolean;
}>();
const popoverId = `tasks-${useId()}`;
const sessionPopoverId = (id: string) => `${popoverId}-session-${id}`;
const tasksOpen = ref(false);
const tasksPopover = ref<InstanceType<typeof ComposerCountPopover>>();
const selectedTask = ref<{ id: string; sessionId?: string }>();
const tasks = computed(() => {
  const runningCron = props.cronRuns.filter((run) => run.status === "running");
  const cronSessions = new Set(runningCron.map((run) => run.sessionId));
  return [
    ...(props.memoryPending || props.memoryError || props.compacting
      ? [
          {
            id: "memory",
            title: props.memoryError
              ? "Memory preparation error"
              : props.memoryPending
                ? "Preparing memory"
                : "Compacting memory",
            detail: props.memoryPending
              ? `${props.memoryPending.toLocaleString("en-US")} ${props.memoryPending === 1 ? "message" : "messages"} remaining`
              : "Memory",
            error: props.memoryError,
            sessionId: undefined,
          },
        ]
      : []),
    ...runningCron.map((run) => ({
      id: `cron-${run.runId}`,
      title: run.prompt,
      detail: `Cron · ${run.workspaceId}`,
      sessionId: run.sessionId,
      error: undefined,
    })),
    ...props.subagents
      .filter((agent) => !cronSessions.has(agent.sessionId))
      .map((agent) => ({
        id: `agent-${agent.sessionId}`,
        title: agent.prompt,
        detail: `${agent.remote?.connectionState === "offline" ? `Offline · last known ${agent.remote.status ?? "unknown"} · ` : ""}Subagent · ${agent.workspaceId} · ${agent.model} · ${agent.thinkingLevel}`,
        sessionId: agent.sessionId,
        error: undefined,
      })),
  ];
});
const hasRunningTasks = computed(
  () =>
    Boolean(props.memoryPending || props.compacting) ||
    tasks.value.some(
      (task) =>
        task.id !== "memory" &&
        !props.subagents.some(
          (agent) =>
            task.id === `agent-${agent.sessionId}` && agent.remote?.connectionState === "offline",
        ),
    ),
);
const sessionTasks = computed(() => {
  const current = tasks.value.filter((task) => task.sessionId);
  if (selectedTask.value && !current.some((task) => task.id === selectedTask.value!.id)) {
    return [...current, selectedTask.value];
  }
  return current;
});
async function openSession(task: { id: string; sessionId?: string }): Promise<void> {
  selectedTask.value = task;
  tasksPopover.value!.close();
  await nextTick();
  document.getElementById(sessionPopoverId(task.id))!.showPopover();
}
function sessionToggle(taskId: string, event: Event): void {
  if ((event as ToggleEvent).newState === "closed" && selectedTask.value?.id === taskId) {
    selectedTask.value = undefined;
  }
}
</script>

<template>
  <ComposerCountPopover
    ref="tasksPopover"
    :id="popoverId"
    label="Running tasks"
    :count="tasks.length"
    noun="task"
    trigger-class="tasks-control"
    align-narrow-viewport-left
    :show-trigger="Boolean(tasks.length || tasksOpen)"
    @toggle="tasksOpen = ($event as ToggleEvent).newState === 'open'"
  >
    <template #icon><Activity aria-hidden="true" /></template>
    <template #status>
      <span v-if="hasRunningTasks" class="spinner tasks-control__spinner" aria-hidden="true" />
      <CircleAlert
        v-if="props.memoryError"
        class="tasks-control__warning"
        :class="{ 'tasks-control__warning--running': hasRunningTasks }"
        aria-label="Memory error"
      />
    </template>
    <header class="composer-list-popover__header">Running tasks</header>
    <component
      :is="task.sessionId ? 'button' : 'article'"
      v-for="task in tasks"
      :key="task.id"
      class="tasks-popover__task"
      :type="task.sessionId ? 'button' : undefined"
      :popovertarget="task.sessionId ? sessionPopoverId(task.id) : undefined"
      :aria-label="task.sessionId ? `Open task session: ${task.title}` : undefined"
      @click.prevent="task.sessionId && openSession(task)"
    >
      <span class="tasks-popover__details">
        <strong>{{ task.title }}</strong>
        <span>{{ task.detail }}</span>
        <span v-if="task.error" class="tasks-popover__error" role="alert">{{ task.error }}</span>
      </span>
      <PanelRightOpen
        v-if="task.sessionId"
        class="tasks-popover__open"
        :size="16"
        aria-hidden="true"
      />
      <CircleAlert v-else-if="task.error" :size="16" aria-hidden="true" />
      <span v-else class="spinner" aria-hidden="true" />
    </component>
    <p v-if="!tasks.length" class="composer-list-popover__empty">No running tasks.</p>
  </ComposerCountPopover>
  <template v-for="task in sessionTasks" :key="task.id">
    <SubagentSessionPopover
      v-if="task.sessionId"
      :popover-id="sessionPopoverId(task.id)"
      :session-id="task.sessionId"
      :header-title="task.id.startsWith('cron-') ? 'Cron run' : 'Subagent'"
      :cron-run="props.cronRuns.find((run) => task.id === `cron-${run.runId}`)"
      @toggle="sessionToggle(task.id, $event)"
    />
  </template>
</template>

<style scoped>
.tasks-control__warning {
  position: absolute;
  top: 0;
  left: 0;
}

.tasks-control__warning--running {
  left: 0.9rem;
}

.tasks-control__spinner {
  display: block;
  width: 0.7rem;
  height: 0.7rem;
  border-width: 1.5px;
}

.tasks-popover__task {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-height: 44px;
  height: auto;
  width: 100%;
  padding: 0.75rem 1rem;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-weight: 400;
  text-align: left;
}

button.tasks-popover__task {
  cursor: pointer;
}

button.tasks-popover__task:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}

.tasks-popover__task + .tasks-popover__task {
  border-top: 1px solid var(--color-border-soft);
}

.tasks-popover__open {
  flex: 0 0 auto;
  color: var(--color-text);
}

@media (hover: hover) {
  button.tasks-popover__task:hover {
    background: var(--color-bg-elevated-soft);
  }
}

.tasks-popover__details {
  display: grid;
  flex: 1;
  min-width: 0;
  gap: 0.2rem;
  font-size: 0.74rem;
  color: var(--color-text-subtle);
}

.tasks-popover__details strong {
  color: var(--color-text);
  font-size: 0.84rem;
}

.tasks-popover__details > * {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tasks-popover__details > .tasks-popover__error {
  color: var(--color-error);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
