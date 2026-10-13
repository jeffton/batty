<script setup lang="ts">
import { Activity, PanelRightOpen } from "@lucide/vue";
import { computed, nextTick, ref, useId } from "vue";
import BasePopover from "./BasePopover.vue";
import SubagentSessionPopover from "./SubagentSessionPopover.vue";
import type { CronRunLog, RunningSubagent } from "@/shared/types";

const props = defineProps<{
  subagents: RunningSubagent[];
  cronRuns: CronRunLog[];
  memoryPending?: number;
  compacting?: boolean;
}>();
const popoverId = `tasks-${useId()}`;
const sessionPopoverId = (id: string) => `${popoverId}-session-${id}`;
const tasksOpen = ref(false);
const tasksPopover = ref<InstanceType<typeof BasePopover>>();
const selectedTask = ref<{ id: string; sessionId?: string }>();
const tasks = computed(() => {
  const runningCron = props.cronRuns.filter((run) => run.status === "running");
  const cronSessions = new Set(runningCron.map((run) => run.sessionId));
  return [
    ...(props.memoryPending || props.compacting
      ? [
          {
            id: "memory",
            title: props.memoryPending ? "Preparing memory" : "Compacting memory",
            detail: "Memory",
            sessionId: undefined,
          },
        ]
      : []),
    ...runningCron.map((run) => ({
      id: `cron-${run.runId}`,
      title: run.prompt,
      detail: `Cron · ${run.workspaceId}`,
      sessionId: run.sessionId,
    })),
    ...props.subagents
      .filter((agent) => !cronSessions.has(agent.sessionId))
      .map((agent) => ({
        id: `agent-${agent.sessionId}`,
        title: agent.prompt,
        detail: `Subagent · ${agent.workspaceId} · ${agent.model} · ${agent.thinkingLevel}`,
        sessionId: agent.sessionId,
      })),
  ];
});
const sessionTasks = computed(() => {
  const current = tasks.value.filter((task) => task.sessionId);
  if (selectedTask.value && !current.some((task) => task.id === selectedTask.value!.id)) {
    return [...current, selectedTask.value];
  }
  return current;
});
async function openSession(task: { id: string; sessionId?: string }): Promise<void> {
  selectedTask.value = task;
  tasksPopover.value!.hidePopover();
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
  <button
    v-if="tasks.length || tasksOpen"
    class="tasks-control"
    type="button"
    :popovertarget="popoverId"
    aria-label="Running tasks"
    aria-haspopup="dialog"
  >
    <Activity :size="17" aria-hidden="true" />
    <span class="tasks-control__info">
      <strong>{{ tasks.length }} {{ tasks.length === 1 ? "task" : "tasks" }}</strong>
      <span v-if="tasks.length" class="spinner tasks-control__spinner" aria-hidden="true" />
    </span>
  </button>
  <BasePopover
    ref="tasksPopover"
    :id="popoverId"
    class="tasks-popover"
    floating
    anchor-up
    role="dialog"
    aria-label="Running tasks"
    @toggle="tasksOpen = ($event as ToggleEvent).newState === 'open'"
  >
    <header class="tasks-popover__header">Running tasks</header>
    <div class="tasks-popover__list">
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
        </span>
        <PanelRightOpen
          v-if="task.sessionId"
          class="tasks-popover__open"
          :size="16"
          aria-hidden="true"
        />
        <span v-else class="spinner" aria-hidden="true" />
      </component>
      <p v-if="!tasks.length" class="tasks-popover__empty">No running tasks.</p>
    </div>
  </BasePopover>
  <template v-for="task in sessionTasks" :key="task.id">
    <SubagentSessionPopover
      v-if="task.sessionId"
      :popover-id="sessionPopoverId(task.id)"
      :session-id="task.sessionId"
      :header-title="task.id.startsWith('cron-') ? 'Cron run' : 'Subagent'"
      @toggle="sessionToggle(task.id, $event)"
    />
  </template>
</template>

<style scoped>
.tasks-control {
  min-width: 44px;
  min-height: 44px;
  flex-shrink: 1;
  padding: 0 0.25rem;
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  border: 0;
  border-radius: 0.5rem;
  background: transparent;
  color: var(--color-text-muted);
  font-family: inherit;
  font-size: 0.78rem;
  white-space: nowrap;
  cursor: pointer;
}

.tasks-control__info {
  min-width: 0;
  display: grid;
  gap: 0.2rem;
  text-align: left;
  line-height: 1.05;
}

.tasks-control__info strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.8rem;
  color: var(--color-text-strong);
}

.tasks-control__spinner {
  width: 0.7rem;
  height: 0.7rem;
  border-width: 1.5px;
}

@media (hover: hover) {
  .tasks-control:hover {
    background: var(--color-bg-elevated);
  }
}

:global(.tasks-popover) {
  display: none;
}

:global(.tasks-popover:popover-open) {
  display: flex;
  flex-direction: column;
  width: min(22rem, calc(100vw - 1rem));
  --anchored-popover-max-height: 24rem;
  max-height: 24rem;
  overflow: hidden;
  padding: 0;
}

.tasks-popover__header {
  position: relative;
  z-index: 1;
  flex-shrink: 0;
  padding: 0.9rem 1rem 0.75rem;
  border-bottom: 1px solid var(--color-border-soft);
  background: var(--color-bg-panel-strong);
  box-shadow: var(--color-shadow-header);
  color: var(--color-text-strong);
  font-size: 1rem;
  font-weight: 700;
}

.tasks-popover__list {
  min-height: 0;
  overflow-y: auto;
  background: var(--color-bg-app);
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

.tasks-popover__empty {
  margin: 0;
  padding: 0.5rem;
  color: var(--color-text-subtle);
}
</style>
