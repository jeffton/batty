<script setup lang="ts">
import { Check, Palette, Save } from "@lucide/vue";
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
    await store.setAppearance({ title, color: appearanceColor.value });
    appearanceTitle.value = store.settings.appearance.title;
  } catch (error) {
    appearanceError.value = error instanceof Error ? error.message : String(error);
  } finally {
    appearanceSaving.value = false;
  }
}

watch(
  () => store.settings.appearance,
  (appearance) => {
    appearanceTitle.value = appearance.title;
    appearanceColor.value = appearance.color;
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
    <div class="settings-popover__section-title-row">
      <Palette :size="15" />
      <div class="settings-popover__group-title">Appearance</div>
    </div>

    <label class="settings-popover__field">
      <span>App title</span>
      <input
        v-model="appearanceTitle"
        class="settings-popover__input settings-popover__input--title"
        type="text"
        maxlength="40"
        autocomplete="off"
        :disabled="appearanceSaving"
        @keydown.enter="saveAppearance"
      />
    </label>

    <fieldset class="settings-popover__color-fieldset">
      <legend>Color</legend>
      <div class="settings-popover__colors">
        <label
          v-for="color in APP_COLOR_OPTIONS"
          :key="color.id"
          class="settings-popover__color-option"
          :title="color.label"
        >
          <input
            v-model="appearanceColor"
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

    <button
      class="settings-popover__action settings-popover__action--primary"
      type="button"
      :disabled="appearanceSaving || !appearanceTitle.trim()"
      @click="saveAppearance"
    >
      <Save :size="14" /> {{ appearanceSaving ? "Saving…" : "Save appearance" }}
    </button>
    <div v-if="appearanceError" class="settings-popover__error" role="alert">
      {{ appearanceError }}
    </div>
  </section>
</template>
