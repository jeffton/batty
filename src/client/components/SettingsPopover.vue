<script setup lang="ts">
import { LogOut } from "@lucide/vue";
import { ref } from "vue";
import FullPopover from "@/client/components/FullPopover.vue";
import PopoverTabs from "./PopoverTabs.vue";
import AppearanceSettings from "./settings/AppearanceSettings.vue";
import AssistantSettings from "./settings/AssistantSettings.vue";
import AuthSettings from "./settings/AuthSettings.vue";
import EnvironmentSettings from "./settings/EnvironmentSettings.vue";
import "./settings/settings.css";

const props = defineProps<{
  popoverId: string;
  anchorName: string;
}>();

const emit = defineEmits<{ logout: [] }>();
const tabs = ["Assistant", "Appearance", "Auth"] as const;
const activeTab = ref<string>("Assistant");
const open = ref(false);
const expandedItemId = ref<string>();

function closePopover(): void {
  const element = document.getElementById(props.popoverId) as HTMLElement | null;
  element?.hidePopover();
}

function logout(): void {
  closePopover();
  emit("logout");
}

function handlePopoverToggle(event: Event): void {
  open.value = (event as Event & { newState?: "open" | "closed" }).newState === "open";
  if (!open.value) {
    expandedItemId.value = undefined;
  }
}
</script>

<template>
  <FullPopover
    class="settings-popover"
    :popover-id="props.popoverId"
    :anchor-name="props.anchorName"
    title="Settings"
    close-label="Close settings"
    @toggle="handlePopoverToggle"
  >
    <template #header-content>
      <PopoverTabs v-model="activeTab" :id-prefix="props.popoverId" label="Settings" :tabs="tabs" />
    </template>
    <div
      v-for="tab in tabs"
      v-show="activeTab === tab"
      :id="`${props.popoverId}-${tab}-panel`"
      :key="tab"
      class="settings-popover__body"
      role="tabpanel"
      :aria-labelledby="`${props.popoverId}-${tab}-tab`"
      tabindex="0"
    >
      <template v-if="tab === 'Assistant'">
        <AssistantSettings :open="open" />
      </template>
      <AppearanceSettings v-else-if="tab === 'Appearance'" :open="open" />
      <template v-else>
        <AuthSettings v-model:expanded-item-id="expandedItemId" :open="open" />
        <EnvironmentSettings :open="open" />
        <section class="settings-popover__section settings-popover__section--logout">
          <button
            class="settings-popover__action settings-popover__action--danger"
            type="button"
            @click="logout"
          >
            <LogOut :size="14" /> Log out
          </button>
        </section>
      </template>
    </div>
  </FullPopover>
</template>
