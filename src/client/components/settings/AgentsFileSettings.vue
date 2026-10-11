<script setup lang="ts">
import { Pencil, Save, X } from "@lucide/vue";
import { ref, watch } from "vue";
import { useAppStore } from "@/client/stores/app";

const props = defineProps<{ open: boolean }>();
const expandedItemId = defineModel<string>("expandedItemId");
const store = useAppStore();
const AGENTS_ITEM_ID = "batty-agents";
const battyAgentsInput = ref("");
const battyAgentsLoading = ref(false);
const battyAgentsSaving = ref(false);
const battyAgentsError = ref("");
async function loadBattyAgentsFile(): Promise<void> {
  expandedItemId.value = AGENTS_ITEM_ID;
  battyAgentsLoading.value = true;
  battyAgentsError.value = "";
  try {
    battyAgentsInput.value = await store.getBattyAgentsFile();
  } catch (error) {
    battyAgentsError.value = error instanceof Error ? error.message : String(error);
  } finally {
    battyAgentsLoading.value = false;
  }
}

async function toggleBattyAgentsEditor(): Promise<void> {
  if (isExpanded(AGENTS_ITEM_ID)) {
    expandedItemId.value = undefined;
    return;
  }

  await loadBattyAgentsFile();
}

async function saveBattyAgentsFile(): Promise<void> {
  battyAgentsSaving.value = true;
  battyAgentsError.value = "";
  try {
    battyAgentsInput.value = await store.setBattyAgentsFile(battyAgentsInput.value);
    expandedItemId.value = undefined;
  } catch (error) {
    battyAgentsError.value = error instanceof Error ? error.message : String(error);
  } finally {
    battyAgentsSaving.value = false;
  }
}

function isExpanded(itemId: string): boolean {
  return expandedItemId.value === itemId;
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      battyAgentsError.value = "";
    }
  },
);
</script>

<template>
  <section class="settings-popover__section">
    <div class="settings-popover__group-title">Batty AGENTS file</div>

    <article class="settings-popover__item">
      <div class="settings-popover__item-top">
        <div class="settings-popover__item-meta">
          <strong>AGENTS.md</strong>
          <div class="settings-popover__help">Edit <code>.batty/AGENTS.md</code>.</div>
        </div>

        <button
          class="settings-popover__icon-btn"
          type="button"
          :disabled="battyAgentsLoading || battyAgentsSaving"
          @click="toggleBattyAgentsEditor"
        >
          <component :is="isExpanded(AGENTS_ITEM_ID) ? X : Pencil" :size="14" />
        </button>
      </div>

      <div v-if="isExpanded(AGENTS_ITEM_ID)" class="settings-popover__editor">
        <textarea
          v-model="battyAgentsInput"
          class="settings-popover__input settings-popover__textarea"
          rows="12"
          spellcheck="false"
          placeholder="Write AGENTS instructions"
          :disabled="battyAgentsLoading || battyAgentsSaving"
        />
        <div class="settings-popover__editor-actions">
          <button
            class="settings-popover__action settings-popover__action--primary"
            type="button"
            :disabled="battyAgentsLoading || battyAgentsSaving"
            @click="saveBattyAgentsFile"
          >
            <Save :size="14" />
            {{ battyAgentsLoading ? "Loading…" : battyAgentsSaving ? "Saving…" : "Save" }}
          </button>
        </div>
        <div v-if="battyAgentsError" class="settings-popover__error">
          {{ battyAgentsError }}
        </div>
      </div>
    </article>
  </section>
</template>
