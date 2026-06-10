<script setup lang="ts">
import ThinkingLevelPicker from "@/client/components/ThinkingLevelPicker.vue";
import { formatShortDateTime } from "@/client/lib/formatting";
import type { CronDraft } from "@/client/composables/useCronJobDrafts";
import type { CronJob, ModelInfo } from "@/shared/types";
import { Pencil, Save, Trash2, X } from "@lucide/vue";

const props = defineProps<{
  job: CronJob;
  draft: CronDraft;
  models: ModelInfo[];
  sessionLabel: string;
  thinkingOptions: string[];
}>();

const emit = defineEmits<{
  edit: [];
  cancel: [];
  save: [];
  delete: [];
}>();
</script>

<template>
  <article class="cron-popover__job">
    <div class="cron-popover__job-top">
      <div class="cron-popover__job-meta">
        <strong>{{ props.job.scheduleLabel }}</strong>
        <span v-if="props.job.state.nextRunAtMs"
          >Next: {{ formatShortDateTime(props.job.state.nextRunAtMs) }}</span
        >
        <span>Session: {{ props.sessionLabel }}</span>
        <span v-if="props.job.state.lastRunAtMs && props.job.state.lastStatus">
          Last: {{ formatShortDateTime(props.job.state.lastRunAtMs) }} ·
          {{ props.job.state.lastStatus }}
        </span>
        <span v-else-if="props.job.state.lastRunAtMs">
          Last: {{ formatShortDateTime(props.job.state.lastRunAtMs) }}
        </span>
      </div>

      <div class="cron-popover__job-actions">
        <button
          class="cron-popover__icon-btn"
          type="button"
          :disabled="props.draft.saving || props.draft.deleting"
          @click.stop.prevent="props.draft.editing ? emit('cancel') : emit('edit')"
        >
          <component :is="props.draft.editing ? X : Pencil" :size="14" />
        </button>
        <button
          class="cron-popover__icon-btn cron-popover__icon-btn--danger"
          type="button"
          :disabled="props.draft.deleting"
          @click.stop.prevent="emit('delete')"
        >
          <Trash2 :size="14" />
        </button>
      </div>
    </div>

    <div v-if="!props.draft.editing" class="cron-popover__readonly">
      <div class="cron-popover__readonly-label">Prompt</div>
      <div class="cron-popover__prompt-preview">{{ props.job.prompt }}</div>
    </div>

    <div v-else class="cron-popover__editor">
      <textarea
        v-model="props.draft.prompt"
        class="cron-popover__prompt"
        rows="5"
        :disabled="props.draft.saving || props.draft.deleting"
      />

      <div class="cron-popover__edit-fields">
        <select
          v-model="props.draft.model"
          class="cron-popover__select"
          :disabled="props.draft.saving || props.draft.deleting"
        >
          <option v-for="model in props.models" :key="model.id" :value="model.id">
            {{ model.label }}
          </option>
        </select>

        <ThinkingLevelPicker
          v-if="props.thinkingOptions.length > 0"
          class="cron-popover__thinking-picker"
          :options="props.thinkingOptions"
          :current="props.draft.thinkingLevel"
          :disabled="props.draft.saving || props.draft.deleting"
          @change="props.draft.thinkingLevel = $event"
        />
        <div v-else class="cron-popover__thinking-unavailable">Effort unavailable</div>

        <select
          v-model="props.draft.sessionKind"
          class="cron-popover__select"
          :disabled="props.draft.saving || props.draft.deleting"
        >
          <option value="new">new session</option>
          <option value="daily-inline">daily session · inline</option>
          <option value="daily-detached">daily session · detached</option>
        </select>

        <label v-if="props.draft.sessionKind === 'daily-detached'" class="cron-popover__checkbox">
          <input
            v-model="props.draft.includePreviousContext"
            type="checkbox"
            :disabled="props.draft.saving || props.draft.deleting"
          />
          <span>Include previous context</span>
        </label>
      </div>

      <div class="cron-popover__editor-actions">
        <button
          class="cron-popover__save"
          type="button"
          :disabled="props.draft.saving || props.draft.deleting"
          @click.stop.prevent="emit('save')"
        >
          <Save :size="14" /> {{ props.draft.saving ? "Saving…" : "Save" }}
        </button>
      </div>
    </div>

    <div v-if="props.job.state.lastError" class="cron-popover__server-error">
      {{ props.job.state.lastError }}
    </div>
    <div v-if="props.draft.error" class="cron-popover__server-error">
      {{ props.draft.error }}
    </div>
  </article>
</template>

<style scoped>
.cron-popover__job {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
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

.cron-popover__job-actions {
  display: inline-flex;
  align-items: center;
  gap: 0.15rem;
}

.cron-popover__readonly {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.cron-popover__readonly-label {
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--color-text-subtle);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.cron-popover__prompt-preview,
.cron-popover__prompt,
.cron-popover__select {
  width: 100%;
  border: 1px solid var(--color-border-soft);
  border-radius: 0.6rem;
  background: var(--color-bg-app);
  color: inherit;
  font: inherit;
  outline: none;
  transition: border-color 80ms ease;
}

.cron-popover__prompt-preview {
  padding: 0.65rem 0.75rem;
  font-family: var(--font-family-mono);
  font-size: 0.9rem;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.cron-popover__editor {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.cron-popover__prompt {
  min-height: 6rem;
  resize: vertical;
  padding: 0.65rem 0.75rem;
  font-family: var(--font-family-mono);
  font-size: 0.95rem;
  line-height: 1.5;
}

.cron-popover__prompt:focus,
.cron-popover__select:focus {
  border-color: var(--color-accent);
}

.cron-popover__edit-fields {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.cron-popover__select {
  padding: 0.55rem 0.65rem;
}

.cron-popover__thinking-picker {
  width: 100%;
}

.cron-popover__thinking-unavailable {
  padding: 0.55rem 0.65rem;
  border: 1px dashed var(--color-border-soft);
  border-radius: 0.6rem;
  color: var(--color-text-subtle);
  font-size: 0.82rem;
  text-align: center;
}

.cron-popover__checkbox {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.15rem 0.1rem;
  color: var(--color-text);
  font-size: 0.82rem;
}

.cron-popover__checkbox input {
  margin: 0;
}

.cron-popover__editor-actions {
  display: flex;
  justify-content: flex-start;
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

@media (hover: hover) {
  .cron-popover__icon-btn--danger:hover {
    background: var(--color-error-soft);
    color: var(--color-error);
  }
}

.cron-popover__save:disabled,
.cron-popover__icon-btn:disabled,
.cron-popover__prompt:disabled,
.cron-popover__select:disabled,
.cron-popover__checkbox input:disabled {
  opacity: 0.6;
}

.cron-popover__server-error {
  color: var(--color-error);
  font-size: 0.78rem;
}
</style>
