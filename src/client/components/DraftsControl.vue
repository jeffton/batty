<script setup lang="ts">
import { FilePlus, Files, PencilLine, Trash2 } from "@lucide/vue";
import { computed, ref, useId } from "vue";
import ComposerCountPopover from "./ComposerCountPopover.vue";
import type { Draft } from "@/client/lib/drafts-db";

const props = defineProps<{
  drafts: Draft[];
  canSave: boolean;
  busy: boolean;
  canTake: boolean;
  error: string;
}>();
const emit = defineEmits<{ save: []; open: []; select: [id: string]; remove: [id: string] }>();
const id = `drafts-${useId()}`;
const popover = ref<InstanceType<typeof ComposerCountPopover>>();
const count = computed(
  () => `${props.drafts.length} ${props.drafts.length === 1 ? "draft" : "drafts"}`,
);
defineExpose({ close: () => popover.value?.close() });
</script>

<template>
  <ComposerCountPopover
    :id="id"
    ref="popover"
    :label="`Drafts: ${count}`"
    :count="props.drafts.length"
    noun="draft"
    dialog-label="Drafts"
    @toggle="($event as ToggleEvent).newState === 'open' && emit('open')"
  >
    <template #icon><Files :size="17" aria-hidden="true" /></template>
    <header class="composer-list-popover__header drafts-control__header">
      <span>Drafts</span>
      <button
        type="button"
        class="chrome-button drafts-control__save"
        title="Save to drafts"
        aria-label="Save to drafts"
        :disabled="!props.canSave"
        @click="emit('save')"
      >
        <FilePlus :size="17" aria-hidden="true" />
      </button>
    </header>
    <p v-if="props.error" class="drafts-control__error" role="status">{{ props.error }}</p>
    <p v-if="!props.drafts.length" class="composer-list-popover__empty">No drafts.</p>
    <div v-for="draft in props.drafts" :key="draft.id" class="drafts-control__entry">
      <button
        type="button"
        class="drafts-control__take"
        :disabled="!props.canTake"
        @click="emit('select', draft.id)"
      >
        <PencilLine :size="16" aria-hidden="true" />
        <span>
          <strong>{{
            draft.text.trim() || draft.files.map((file) => file.name).join(", ")
          }}</strong>
          <small v-if="draft.files.length && draft.text.trim()">
            {{ draft.files.map((file) => file.name).join(", ") }}
          </small>
        </span>
      </button>
      <button
        class="chrome-button drafts-control__delete"
        type="button"
        title="Delete draft"
        :aria-label="`Delete draft: ${draft.text.trim() || draft.files.map((file) => file.name).join(', ')}`"
        :aria-disabled="props.busy"
        @click="!props.busy && emit('remove', draft.id)"
      >
        <Trash2 :size="16" aria-hidden="true" />
      </button>
    </div>
  </ComposerCountPopover>
</template>

<style scoped>
.drafts-control__header,
.drafts-control__entry {
  display: flex;
  align-items: center;
  padding-block: 0.375rem;
  padding-inline-end: 0.625rem;
}

/* The header shares the rows' scrollport so a classic scrollbar
   takes the same horizontal space from both action columns. */
.drafts-control__header {
  justify-content: space-between;
  padding-inline-start: 1rem;
}

.drafts-control__save,
.drafts-control__delete {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  flex: none;
  padding: 0;
}

.drafts-control__save:disabled {
  opacity: 0.4;
}

.drafts-control__entry {
  border-top: 1px solid var(--color-border-soft);
}

.drafts-control__take {
  display: flex;
  align-items: center;
  min-height: 44px;
  min-width: 0;
  flex: 1;
  gap: 0.75rem;
  padding: 0.5rem 0.625rem 0.5rem 1rem;
  text-align: left;
  color: var(--color-text);
  border: 0;
  background: transparent;
  font: inherit;
  font-size: 0.84rem;
  cursor: pointer;
}

.drafts-control__take:focus-visible,
.drafts-control__delete:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}

.drafts-control__take svg {
  flex-shrink: 0;
}

.drafts-control__take span {
  display: grid;
  min-width: 0;
}

.drafts-control__take span > * {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.composer-list-popover__empty {
  padding-inline: 1rem;
}

.drafts-control__error {
  padding: 0.5rem 1rem;
  margin: 0;
  color: var(--color-error);
}

@media (hover: hover) {
  .drafts-control__take:hover:not(:disabled) {
    background: var(--color-bg-elevated-soft);
  }
}
</style>
