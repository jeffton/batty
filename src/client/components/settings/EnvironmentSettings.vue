<script setup lang="ts">
import { Save } from "@lucide/vue";
import SettingsField from "./SettingsField.vue";
import { ref, watch } from "vue";
import DeleteButton from "@/client/components/DeleteButton.vue";
import {
  listEnvironmentVariables,
  removeEnvironmentVariable,
  setEnvironmentVariable,
} from "@/client/lib/api";

const props = defineProps<{ open: boolean }>();
const environmentNames = ref<string[]>([]);
const environmentName = ref("");
const environmentValue = ref("");
const environmentPending = ref(false);
const environmentError = ref("");
async function loadEnvironmentNames(): Promise<void> {
  environmentNames.value = [];
  environmentError.value = "";
  try {
    environmentNames.value = (await listEnvironmentVariables()).names;
  } catch (error) {
    environmentError.value = error instanceof Error ? error.message : String(error);
  }
}

async function saveEnvironmentVariable(): Promise<void> {
  environmentPending.value = true;
  environmentError.value = "";
  try {
    environmentNames.value = (
      await setEnvironmentVariable(environmentName.value.trim(), environmentValue.value)
    ).names;
    environmentName.value = "";
    environmentValue.value = "";
  } catch (error) {
    environmentError.value = error instanceof Error ? error.message : String(error);
  } finally {
    environmentPending.value = false;
  }
}

async function deleteEnvironmentVariable(name: string): Promise<void> {
  environmentPending.value = true;
  environmentError.value = "";
  try {
    environmentNames.value = (await removeEnvironmentVariable(name)).names;
  } catch (error) {
    environmentError.value = error instanceof Error ? error.message : String(error);
  } finally {
    environmentPending.value = false;
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      void loadEnvironmentNames();
    } else {
      environmentName.value = "";
      environmentValue.value = "";
    }
  },
);
</script>

<template>
  <section class="settings-popover__section">
    <div class="settings-popover__group-title">Environment variables</div>
    <div v-for="name in environmentNames" :key="name" class="settings-popover__environment-row">
      <code>{{ name }}</code>
      <DeleteButton
        class="settings-popover__action"
        :label="`Remove ${name}`"
        :disabled="environmentPending"
        @confirm="deleteEnvironmentVariable(name)"
      />
    </div>
    <form class="settings-popover__editor" @submit.prevent="saveEnvironmentVariable">
      <SettingsField label="Variable name">
        <input
          v-model="environmentName"
          class="settings-popover__input"
          aria-label="Variable name"
          placeholder="VARIABLE_NAME"
          autocomplete="off"
          spellcheck="false"
          :disabled="environmentPending"
        />
      </SettingsField>
      <SettingsField label="Value">
        <input
          v-model="environmentValue"
          class="settings-popover__input"
          aria-label="Variable value"
          type="text"
          placeholder="Value"
          autocomplete="off"
          :disabled="environmentPending"
        />
        <template #action>
          <button
            class="settings-popover__action settings-popover__action--primary"
            type="submit"
            :disabled="
              environmentPending || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(environmentName.trim())
            "
          >
            <Save :size="14" /> {{ environmentPending ? "Saving…" : "Set variable" }}
          </button>
        </template>
      </SettingsField>
    </form>
    <div v-if="environmentError" class="settings-popover__error" role="alert">
      {{ environmentError }}
    </div>
  </section>
</template>
