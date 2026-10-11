<script setup lang="ts">
import { computed, ref, watch } from "vue";
import ModelConfigSelector from "@/client/components/ModelConfigSelector.vue";
import { useAppStore } from "@/client/stores/app";
import {
  normalizeModelThinkingLevel,
  resolveModelThinkingOptions,
} from "@/client/lib/thinking-levels";

const props = defineProps<{ open: boolean }>();
const store = useAppStore();
const DEFAULT_MODEL_POPOVER_ID = "settings-default-model-popover";
const DEFAULT_MODEL_ANCHOR = "--settings-default-model-anchor";
const defaultModelSaving = ref(false);
const defaultModelError = ref("");
const defaultModelId = computed(() =>
  store.settings.defaultProvider && store.settings.defaultModel
    ? `${store.settings.defaultProvider}/${store.settings.defaultModel}`
    : undefined,
);
const defaultModel = computed(() =>
  store.models.find((model) => model.id === defaultModelId.value),
);
const defaultThinkingOptions = computed(() => resolveModelThinkingOptions(defaultModel.value));
const defaultThinkingLevel = computed(() =>
  normalizeModelThinkingLevel(defaultModel.value, store.settings.defaultThinkingLevel),
);
const defaultModelLabel = computed(
  () =>
    defaultModel.value?.label.split(" · ", 1)[0] ?? store.settings.defaultModel ?? "Select a model",
);

async function saveDefaultModel(modelId: string): Promise<void> {
  const model = store.models.find((candidate) => candidate.id === modelId);
  await saveDefaultModelConfig(
    modelId,
    normalizeModelThinkingLevel(model, store.settings.defaultThinkingLevel),
  );
}

async function saveDefaultThinkingLevel(thinkingLevel: string): Promise<void> {
  if (!defaultModelId.value) {
    return;
  }
  await saveDefaultModelConfig(defaultModelId.value, thinkingLevel);
}

async function saveDefaultModelConfig(modelId: string, thinkingLevel: string): Promise<void> {
  defaultModelSaving.value = true;
  defaultModelError.value = "";
  try {
    await store.setDefaultModel(modelId, thinkingLevel);
  } catch (error) {
    defaultModelError.value = error instanceof Error ? error.message : String(error);
  } finally {
    defaultModelSaving.value = false;
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      defaultModelError.value = "";
    }
  },
);
</script>

<template>
  <section class="settings-popover__section">
    <div class="settings-popover__group-title">Default model</div>
    <div class="settings-popover__help">Used when starting new sessions.</div>
    <ModelConfigSelector
      :model-label="defaultModelLabel"
      :effort-label="
        defaultThinkingOptions.length > 0 ? defaultThinkingLevel : 'Effort unavailable'
      "
      aria-label="Choose default model and effort"
      @refresh-models="store.refreshModels"
      :popover-id="DEFAULT_MODEL_POPOVER_ID"
      :anchor-name="DEFAULT_MODEL_ANCHOR"
      :models="store.models"
      :current-model-id="defaultModelId"
      :current-thinking-level="defaultThinkingLevel"
      :thinking-options="defaultThinkingOptions"
      :disabled="defaultModelSaving"
      @set-model="saveDefaultModel"
      @set-thinking-level="saveDefaultThinkingLevel"
    />
    <div v-if="defaultModelError" class="settings-popover__error" role="alert">
      {{ defaultModelError }}
    </div>
  </section>
</template>
