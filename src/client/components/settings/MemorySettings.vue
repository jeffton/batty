<script setup lang="ts">
import { Network, Save } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import ModelConfigSelector from "@/client/components/ModelConfigSelector.vue";
import { useAppStore } from "@/client/stores/app";

import FullPopover from "../FullPopover.vue";
import MemoryTreeView from "@/client/views/MemoryTreeView.vue";

const treeOpen = ref(false);
const store = useAppStore();
const memoryLanguage = ref("");
const memoryLanguageSaving = ref(false);
const memoryLanguageError = ref("");
const memoryModelSaving = ref(false);
const memoryModelError = ref("");
const memoryModelLabel = computed(
  () =>
    store.models
      .find((model) => model.id === store.settings.memoryModel)
      ?.label.split(" · ", 1)[0] ?? store.settings.memoryModel,
);
watch(
  () => store.settings.memoryLanguage,
  (language) => {
    memoryLanguage.value = language;
  },
  { immediate: true },
);

async function saveMemoryLanguage(): Promise<void> {
  memoryLanguageSaving.value = true;
  memoryLanguageError.value = "";
  try {
    await store.setMemoryLanguage(memoryLanguage.value.trim());
    memoryLanguage.value = store.settings.memoryLanguage;
  } catch (error) {
    memoryLanguageError.value = error instanceof Error ? error.message : String(error);
  } finally {
    memoryLanguageSaving.value = false;
  }
}

async function saveMemoryModel(modelId: string): Promise<void> {
  memoryModelSaving.value = true;
  memoryModelError.value = "";
  try {
    await store.setMemoryModel(modelId);
  } catch (error) {
    memoryModelError.value = error instanceof Error ? error.message : String(error);
  } finally {
    memoryModelSaving.value = false;
  }
}
</script>

<template>
  <div class="settings-popover__editor">
    <div class="settings-popover__group-title">Memory</div>
    <ModelConfigSelector
      :model-label="memoryModelLabel"
      :effort-label="store.settings.memoryReasoning"
      aria-label="Choose memory model"
      @refresh-models="store.refreshModels"
      popover-id="settings-memory-model-popover"
      anchor-name="--settings-memory-model-anchor"
      :models="store.models"
      :current-model-id="store.settings.memoryModel"
      :current-thinking-level="store.settings.memoryReasoning"
      :thinking-options="[]"
      :disabled="memoryModelSaving"
      @set-model="saveMemoryModel"
    />
    <div v-if="memoryModelError" class="settings-popover__error" role="alert">
      {{ memoryModelError }}
    </div>
  </div>
  <form class="settings-popover__editor" @submit.prevent="saveMemoryLanguage">
    <div class="settings-popover__inline">
      <label class="settings-popover__field">
        <span>Memory language</span>
        <input
          v-model="memoryLanguage"
          class="settings-popover__input"
          type="text"
          autocomplete="off"
          :disabled="memoryLanguageSaving"
        />
      </label>
      <button
        class="settings-popover__action settings-popover__action--primary"
        type="submit"
        :disabled="memoryLanguageSaving || !memoryLanguage.trim()"
      >
        <Save :size="14" /> {{ memoryLanguageSaving ? "Saving…" : "Save" }}
      </button>
    </div>
    <div v-if="memoryLanguageError" class="settings-popover__error" role="alert">
      {{ memoryLanguageError }}
    </div>
  </form>
  <button class="settings-popover__action" type="button" popovertarget="settings-memory-tree">
    <Network :size="16" aria-hidden="true" /> Memory tree
  </button>
  <FullPopover
    class="settings-popover"
    popover-id="settings-memory-tree"
    title="Memory tree"
    @toggle="treeOpen = ($event as ToggleEvent).newState === 'open'"
  >
    <MemoryTreeView v-if="treeOpen" embedded />
  </FullPopover>
</template>
