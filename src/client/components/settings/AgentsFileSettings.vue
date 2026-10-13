<script setup lang="ts">
import { FilePenLine, Save } from "@lucide/vue";
import { computed, reactive, ref } from "vue";
import FullPopover from "../FullPopover.vue";
import { useAppStore } from "@/client/stores/app";
import { getAssistantAgentsFile, setAssistantAgentsFile } from "@/client/lib/api";

const store = useAppStore();
const assistant = computed(() => store.workspaces.find((workspace) => workspace.isAssistant));
const drafts = reactive<Record<string, string>>({});
const target = ref<string>();
const title = ref("");
const pendingLoads = reactive(new Set<string>());
const loading = computed(() => !!target.value && pendingLoads.has(target.value));
const saving = ref(false);
const errors = reactive<Record<string, string>>({});
const error = computed(() => (target.value ? errors[target.value] : ""));

async function edit(workspaceId?: string): Promise<void> {
  const key = workspaceId ?? "global";
  target.value = key;
  title.value = workspaceId ? `${assistant.value!.label} / AGENTS.md` : "Batty / AGENTS.md";
  errors[key] = "";
  if (key in drafts || pendingLoads.has(key)) return;
  pendingLoads.add(key);
  try {
    drafts[key] = workspaceId
      ? (await getAssistantAgentsFile(workspaceId)).content
      : await store.getBattyAgentsFile();
  } catch (failure) {
    errors[key] = failure instanceof Error ? failure.message : String(failure);
  } finally {
    pendingLoads.delete(key);
  }
}

async function save(): Promise<void> {
  const key = target.value!;
  saving.value = true;
  errors[key] = "";
  try {
    drafts[key] =
      key === "global"
        ? await store.setBattyAgentsFile(drafts[key]!)
        : (await setAssistantAgentsFile(key, drafts[key]!)).content;
    document.getElementById("settings-agents-editor")!.hidePopover();
  } catch (failure) {
    errors[key] = failure instanceof Error ? failure.message : String(failure);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="settings-popover__instruction-buttons">
    <button
      class="settings-popover__action"
      type="button"
      :disabled="saving"
      popovertarget="settings-agents-editor"
      @click="edit()"
    >
      <FilePenLine :size="16" aria-hidden="true" /> Batty AGENTS.md
    </button>
    <button
      v-if="assistant"
      class="settings-popover__action"
      type="button"
      :disabled="saving"
      popovertarget="settings-agents-editor"
      @click="edit(assistant.id)"
    >
      <FilePenLine :size="16" aria-hidden="true" /> {{ assistant.label }} AGENTS.md
    </button>
  </div>
  <FullPopover class="settings-popover" popover-id="settings-agents-editor" :title="title">
    <template #header-actions>
      <button
        class="settings-popover__action settings-popover__action--primary"
        type="button"
        :disabled="loading || saving || !target || !(target in drafts)"
        @click="save"
      >
        <Save :size="14" />{{ saving ? "Saving…" : "Save" }}
      </button>
    </template>
    <div class="settings-popover__file-editor">
      <div v-if="loading" role="status">Loading…</div>
      <textarea
        v-if="target && target in drafts"
        v-model="drafts[target]"
        class="settings-popover__input"
        aria-label="AGENTS.md instructions"
        spellcheck="false"
        :disabled="loading || saving"
      />
      <div v-if="error" class="settings-popover__error" role="alert">{{ error }}</div>
    </div>
  </FullPopover>
</template>
