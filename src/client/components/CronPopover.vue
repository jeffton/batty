<script setup lang="ts">
import { Save, Trash2 } from "lucide-vue-next";
import { computed, reactive, watch } from "vue";
import { formatShortDateTime } from "@/client/lib/formatting";
import { resolveThinkingOptions } from "@/client/lib/thinking-levels";
import { useAppStore } from "@/client/stores/app";
import type { CronJob } from "@/shared/types";

const props = defineProps<{
  popoverId: string;
  anchorName: string;
}>();

interface CronDraft {
  prompt: string;
  model: string;
  thinkingLevel: string;
  saving: boolean;
  deleting: boolean;
  error: string;
}

const store = useAppStore();
const drafts = reactive<Record<string, CronDraft>>({});
const jobs = computed(() => store.workspaceCronJobs);

function ensureDraft(job: CronJob): CronDraft {
  const existing = drafts[job.id];
  if (existing) {
    return existing;
  }

  const created: CronDraft = {
    prompt: job.prompt,
    model: job.model,
    thinkingLevel: job.thinkingLevel,
    saving: false,
    deleting: false,
    error: "",
  };
  drafts[job.id] = created;
  return created;
}

function syncDrafts(nextJobs: CronJob[]): void {
  const activeIds = new Set(nextJobs.map((job) => job.id));
  for (const job of nextJobs) {
    const draft = ensureDraft(job);
    if (!draft.saving) {
      draft.prompt = job.prompt;
      draft.model = job.model;
      draft.thinkingLevel = job.thinkingLevel;
      draft.error = "";
    }
  }

  for (const jobId of Object.keys(drafts)) {
    if (!activeIds.has(jobId)) {
      delete drafts[jobId];
    }
  }
}

function draftFor(job: CronJob): CronDraft {
  return ensureDraft(job);
}

function thinkingOptions(job: CronJob): string[] {
  const draft = draftFor(job);
  return resolveThinkingOptions(
    {
      model: draft.model,
      thinkingLevel: draft.thinkingLevel,
      availableThinkingLevels: [],
    },
    store.models,
  );
}

function isDirty(job: CronJob): boolean {
  const draft = draftFor(job);
  return (
    draft.prompt !== job.prompt ||
    draft.model !== job.model ||
    draft.thinkingLevel !== job.thinkingLevel
  );
}

async function saveJob(job: CronJob): Promise<void> {
  const draft = draftFor(job);
  draft.saving = true;
  draft.error = "";
  try {
    const updated = await store.updateCronJob(job.id, {
      prompt: draft.prompt,
      model: draft.model,
      thinkingLevel: draft.thinkingLevel,
    });
    draft.prompt = updated.prompt;
    draft.model = updated.model;
    draft.thinkingLevel = updated.thinkingLevel;
  } catch (error) {
    draft.error = error instanceof Error ? error.message : String(error);
  } finally {
    draft.saving = false;
  }
}

async function deleteJob(job: CronJob): Promise<void> {
  const draft = draftFor(job);
  draft.deleting = true;
  draft.error = "";
  try {
    await store.deleteCronJob(job.id);
  } catch (error) {
    draft.error = error instanceof Error ? error.message : String(error);
    draft.deleting = false;
  }
}

watch(
  jobs,
  (nextJobs) => {
    syncDrafts(nextJobs);
  },
  { immediate: true },
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
      <article v-for="job in jobs" :key="job.id" class="cron-popover__job">
        <div class="cron-popover__job-top">
          <div class="cron-popover__job-meta">
            <strong>{{ job.scheduleLabel }}</strong>
            <span v-if="job.state.nextRunAtMs"
              >Next: {{ formatShortDateTime(job.state.nextRunAtMs) }}</span
            >
            <span v-if="job.state.lastRunAtMs">
              Last: {{ formatShortDateTime(job.state.lastRunAtMs) }} ·
              {{ job.state.lastStatus || "?" }}
            </span>
          </div>
          <button
            class="cron-popover__icon-btn cron-popover__icon-btn--danger"
            type="button"
            :disabled="draftFor(job).deleting"
            @click="deleteJob(job)"
          >
            <Trash2 :size="14" />
          </button>
        </div>

        <textarea
          v-model="draftFor(job).prompt"
          class="cron-popover__prompt"
          rows="5"
          :disabled="draftFor(job).saving || draftFor(job).deleting"
        />

        <div class="cron-popover__controls">
          <select
            v-model="draftFor(job).model"
            class="cron-popover__select"
            :disabled="draftFor(job).saving || draftFor(job).deleting"
          >
            <option v-for="model in store.models" :key="model.id" :value="model.id">
              {{ model.label }}
            </option>
          </select>

          <select
            v-model="draftFor(job).thinkingLevel"
            class="cron-popover__select cron-popover__select--thinking"
            :disabled="draftFor(job).saving || draftFor(job).deleting"
          >
            <option v-for="level in thinkingOptions(job)" :key="level" :value="level">
              {{ level }}
            </option>
          </select>

          <button
            class="cron-popover__save"
            type="button"
            :disabled="!isDirty(job) || draftFor(job).saving || draftFor(job).deleting"
            @click="saveJob(job)"
          >
            <Save :size="14" /> {{ draftFor(job).saving ? "Saving…" : "Save" }}
          </button>
        </div>

        <div v-if="job.state.lastError" class="cron-popover__server-error">
          {{ job.state.lastError }}
        </div>
        <div v-if="draftFor(job).error" class="cron-popover__server-error">
          {{ draftFor(job).error }}
        </div>
      </article>

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

.cron-popover__job {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  padding: 0.55rem;
  border-radius: 0.65rem;
  background: var(--color-bg-panel);
  border: 1px solid var(--color-border-soft);
}

.cron-popover__job-top {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
}

.cron-popover__job-meta {
  display: flex;
  flex-direction: column;
  gap: 0.12rem;
  min-width: 0;
  flex: 1;
}

.cron-popover__job-meta strong,
.cron-popover__job-meta span {
  overflow: hidden;
  text-overflow: ellipsis;
}

.cron-popover__job-meta strong {
  font-size: 0.84rem;
  color: var(--color-text-strong);
}

.cron-popover__job-meta span {
  font-size: 0.76rem;
  color: var(--color-text-subtle);
}

.cron-popover__prompt,
.cron-popover__select {
  width: 100%;
  border: 1px solid var(--color-border-soft);
  border-radius: 0.5rem;
  background: var(--color-bg-elevated);
  color: inherit;
  font: inherit;
}

.cron-popover__prompt {
  min-height: 6rem;
  resize: vertical;
  padding: 0.55rem 0.65rem;
}

.cron-popover__controls {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 0.4rem;
}

.cron-popover__select {
  padding: 0.45rem 0.55rem;
}

.cron-popover__select--thinking {
  min-width: 6rem;
}

.cron-popover__save,
.cron-popover__icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  border: 0;
  border-radius: 0.45rem;
  background: var(--color-bg-selection);
  color: var(--color-accent-strong);
  padding: 0.45rem 0.65rem;
  font-size: 0.82rem;
  font-weight: 600;
}

.cron-popover__icon-btn {
  background: transparent;
  color: var(--color-text-muted);
  padding-inline: 0.45rem;
}

.cron-popover__icon-btn--danger:hover {
  background: var(--color-error-soft);
  color: var(--color-error);
}

.cron-popover__save:disabled,
.cron-popover__icon-btn:disabled,
.cron-popover__prompt:disabled,
.cron-popover__select:disabled {
  opacity: 0.6;
}

.cron-popover__server-error {
  color: var(--color-error);
  font-size: 0.78rem;
}

.cron-popover__empty {
  padding: 1rem 0.4rem;
  color: var(--color-text-subtle);
  font-size: 0.85rem;
}

.cron-popover__empty code {
  font-family: var(--font-mono);
}

@media (max-width: 30rem) {
  .cron-popover__controls {
    grid-template-columns: 1fr;
  }
}
</style>
