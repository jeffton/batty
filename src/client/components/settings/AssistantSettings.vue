<script setup lang="ts">
import { Save } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import { useAppStore } from "@/client/stores/app";
import MemorySettings from "./MemorySettings.vue";

const emit = defineEmits<{ close: [] }>();
const store = useAppStore();
const assistantWorkspaceSaving = ref(false);
const assistantWorkspaceError = ref("");
const assistantWorkspaceId = computed(
  () => store.workspaces.find((workspace) => workspace.isAssistant)?.id ?? "",
);

async function saveAssistantWorkspace(event: Event): Promise<void> {
  assistantWorkspaceSaving.value = true;
  assistantWorkspaceError.value = "";
  try {
    await store.setAssistantWorkspace((event.target as HTMLSelectElement).value);
  } catch (error) {
    assistantWorkspaceError.value = error instanceof Error ? error.message : String(error);
  } finally {
    assistantWorkspaceSaving.value = false;
  }
}

const pushTitle = ref("");
const pushTitleSaving = ref(false);
const pushTitleError = ref("");
watch(
  () => store.settings.pushTitle,
  (title) => {
    pushTitle.value = title;
  },
  { immediate: true },
);

async function savePushTitle(): Promise<void> {
  pushTitleSaving.value = true;
  pushTitleError.value = "";
  try {
    await store.setPushTitle(pushTitle.value.trim());
    pushTitle.value = store.settings.pushTitle;
  } catch (error) {
    pushTitleError.value = error instanceof Error ? error.message : String(error);
  } finally {
    pushTitleSaving.value = false;
  }
}
</script>

<template>
  <section class="settings-popover__section" aria-labelledby="assistant-settings-title">
    <h2 id="assistant-settings-title" class="settings-popover__group-title">Assistant</h2>
    <label class="settings-popover__field">
      <span>Workspace</span>
      <select
        class="settings-popover__select"
        :value="assistantWorkspaceId"
        :disabled="assistantWorkspaceSaving"
        @change="saveAssistantWorkspace"
      >
        <option disabled value="">Choose workspace</option>
        <option v-for="workspace in store.workspaces" :key="workspace.id" :value="workspace.id">
          {{ workspace.label }}
        </option>
      </select>
    </label>
    <div v-if="assistantWorkspaceError" class="settings-popover__error" role="alert">
      {{ assistantWorkspaceError }}
    </div>
    <label class="settings-popover__field">
      <span>Push sender</span>
      <input
        v-model="pushTitle"
        class="settings-popover__input"
        type="text"
        :disabled="pushTitleSaving"
        @keydown.enter.prevent="savePushTitle"
      />
    </label>
    <button
      class="settings-popover__action settings-popover__action--primary"
      type="button"
      :disabled="pushTitleSaving || !pushTitle.trim()"
      @click="savePushTitle"
    >
      <Save :size="14" /> {{ pushTitleSaving ? "Saving…" : "Save push sender" }}
    </button>
    <div v-if="pushTitleError" class="settings-popover__error" role="alert">
      {{ pushTitleError }}
    </div>
    <MemorySettings @close="emit('close')" />
  </section>
</template>
