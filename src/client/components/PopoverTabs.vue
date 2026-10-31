<script setup lang="ts">
import { nextTick } from "vue";

const props = defineProps<{
  idPrefix: string;
  label: string;
  tabs: readonly string[];
}>();
const activeTab = defineModel<string>({ required: true });

async function handleKeydown(event: KeyboardEvent): Promise<void> {
  const index = props.tabs.indexOf(activeTab.value);
  const nextIndex =
    event.key === "ArrowRight"
      ? (index + 1) % props.tabs.length
      : event.key === "ArrowLeft"
        ? (index - 1 + props.tabs.length) % props.tabs.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? props.tabs.length - 1
            : undefined;
  if (nextIndex === undefined) return;
  event.preventDefault();
  activeTab.value = props.tabs[nextIndex]!;
  await nextTick();
  const tab = document.getElementById(`${props.idPrefix}-${activeTab.value}-tab`);
  tab?.focus();
  tab?.scrollIntoView({ block: "nearest", inline: "nearest" });
}
</script>

<template>
  <div class="popover-tabs" role="tablist" :aria-label="props.label">
    <button
      v-for="tab in props.tabs"
      :id="`${props.idPrefix}-${tab}-tab`"
      :key="tab"
      type="button"
      role="tab"
      :aria-selected="activeTab === tab"
      :aria-controls="`${props.idPrefix}-${tab}-panel`"
      :tabindex="activeTab === tab ? 0 : -1"
      class="popover-tabs__tab"
      @click="activeTab = tab"
      @keydown="handleKeydown"
    >
      <slot :tab="tab">{{ tab }}</slot>
    </button>
  </div>
</template>

<style scoped>
.popover-tabs {
  display: flex;
  overflow-x: auto;
  scrollbar-width: none;
  padding-inline: 0.5rem;
}

.popover-tabs__tab {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  min-height: 44px;
  padding: 0.45rem 0.8rem;
  border: 0;
  border-bottom: 3px solid transparent;
  border-radius: 0.5rem 0.5rem 0 0;
  background: transparent;
  color: var(--color-text-subtle);
  font-family: inherit;
  font-size: 0.86rem;
  font-weight: 600;
  cursor: pointer;
}

.popover-tabs__tab[aria-selected="true"] {
  border-bottom-color: var(--color-accent);
  color: var(--color-link);
}

@media (hover: hover) {
  .popover-tabs__tab:hover {
    background: var(--color-chrome-hover);
    color: var(--color-link);
  }
}

.popover-tabs__tab:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}
</style>
