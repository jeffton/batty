<script setup lang="ts">
import { Check, Save } from "@lucide/vue";
import SettingsField from "./SettingsField.vue";
import { ref, watch } from "vue";
import { useAppStore } from "@/client/stores/app";
import { APP_COLOR_OPTIONS, type AppColor } from "@/shared/appearance";

const props = defineProps<{ open: boolean }>();
const store = useAppStore();
const appearanceTitle = ref("");
const appearanceColor = ref<AppColor>("neutral");
const appearanceSaving = ref(false);
const appearanceError = ref("");
async function saveAppearance(): Promise<void> {
  const title = appearanceTitle.value.trim();
  if (!title) {
    appearanceError.value = "Enter an app title";
    return;
  }

  appearanceSaving.value = true;
  appearanceError.value = "";
  try {
    await store.setAppearance({ title, color: store.settings.appearance.color });
    appearanceTitle.value = store.settings.appearance.title;
  } catch (error) {
    appearanceError.value = error instanceof Error ? error.message : String(error);
  } finally {
    appearanceSaving.value = false;
  }
}

async function saveColor(color: AppColor): Promise<void> {
  appearanceColor.value = color;
  appearanceSaving.value = true;
  appearanceError.value = "";
  try {
    await store.setAppearance({ title: store.settings.appearance.title, color });
  } catch (error) {
    appearanceColor.value = store.settings.appearance.color;
    appearanceError.value = error instanceof Error ? error.message : String(error);
  } finally {
    appearanceSaving.value = false;
  }
}

watch(
  () => store.settings.appearance.color,
  (color) => {
    appearanceColor.value = color;
  },
  { immediate: true },
);

watch(
  () => store.settings.appearance.title,
  (title) => {
    appearanceTitle.value = title;
  },
  { immediate: true },
);

watch(
  () => props.open,
  (open) => {
    if (open) {
      appearanceError.value = "";
    }
  },
);
</script>

<template>
  <section class="settings-popover__section">
    <SettingsField label="App title">
      <input
        v-model="appearanceTitle"
        class="settings-popover__input settings-popover__input--title"
        type="text"
        maxlength="40"
        autocomplete="off"
        :disabled="appearanceSaving"
        @keydown.enter="saveAppearance"
      />
      <template #action>
        <button
          class="settings-popover__action settings-popover__action--primary"
          type="button"
          :disabled="appearanceSaving || !appearanceTitle.trim()"
          @click="saveAppearance"
        >
          <Save :size="14" /> {{ appearanceSaving ? "Saving…" : "Save" }}
        </button>
      </template>
    </SettingsField>

    <fieldset class="settings-popover__color-fieldset">
      <legend>Color</legend>
      <div class="settings-popover__colors">
        <label
          v-for="color in APP_COLOR_OPTIONS"
          :key="color.id"
          class="settings-popover__action settings-popover__color-option"
          :title="color.label"
        >
          <input
            :checked="appearanceColor === color.id"
            @change="saveColor(color.id)"
            type="radio"
            name="app-color"
            :value="color.id"
            :disabled="appearanceSaving"
          />
          <span
            class="settings-popover__color-swatch"
            :style="{
              backgroundImage: `linear-gradient(135deg, ${color.light} 50%, ${color.dark} 50%)`,
            }"
          >
            <Check v-if="appearanceColor === color.id" :size="15" :stroke-width="3" />
          </span>
          <span>{{ color.label }}</span>
        </label>
      </div>
    </fieldset>

    <div v-if="appearanceError" class="settings-popover__error" role="alert">
      {{ appearanceError }}
    </div>
  </section>
</template>
