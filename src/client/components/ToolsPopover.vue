<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import FullPopover from "@/client/components/FullPopover.vue";
import PopoverTabs from "./PopoverTabs.vue";
import McpSettingsPanel from "@/client/components/McpSettingsPanel.vue";
import { getSessionResources } from "@/client/lib/api";
import { useAppStore } from "@/client/stores/app";
import type { SessionResourcesResponse } from "@/shared/types";

const props = defineProps<{
  popoverId: string;
  anchorName: string;
  workspaceId?: string;
}>();

const store = useAppStore();
const tabs = ["Workspaces", "Skills", "MCPs", "Tools"] as const;
type Tab = (typeof tabs)[number];
const activeTab = ref<string>("Workspaces");
const open = ref(false);
const loading = ref(false);
const error = ref("");
const resources = ref<SessionResourcesResponse>({ skills: [], tools: [] });
const sessionId = computed(() => store.activeSession?.id);
let loadGeneration = 0;

function tabId(tab: Tab): string {
  return `${props.popoverId}-${tab}-tab`;
}

function panelId(tab: Tab): string {
  return `${props.popoverId}-${tab}-panel`;
}

async function loadResources(): Promise<void> {
  const generation = ++loadGeneration;
  resources.value = { skills: [], tools: [] };
  error.value = "";
  loading.value = false;
  if (!open.value || !sessionId.value) return;
  loading.value = true;
  try {
    const result = await getSessionResources(sessionId.value);
    if (generation === loadGeneration) resources.value = result;
  } catch (cause) {
    if (generation === loadGeneration)
      error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (generation === loadGeneration) loading.value = false;
  }
}

function handleToggle(event: Event): void {
  open.value = (event as ToggleEvent).newState === "open";
}

watch([open, sessionId], () => void loadResources());
onBeforeUnmount(() => loadGeneration++);
</script>

<template>
  <FullPopover
    :popover-id="props.popoverId"
    :anchor-name="props.anchorName"
    title="Workspaces and tools"
    close-label="Close workspaces and tools"
    @toggle="handleToggle"
  >
    <template #header-content>
      <PopoverTabs
        v-model="activeTab"
        :id-prefix="props.popoverId"
        label="Workspaces and tools"
        :tabs="tabs"
      />
    </template>

    <div
      v-show="activeTab === 'Workspaces'"
      :id="panelId('Workspaces')"
      role="tabpanel"
      :aria-labelledby="tabId('Workspaces')"
      class="tools-popover__pane"
    >
      <article
        v-for="workspace in store.workspaces"
        :key="workspace.id"
        class="tools-popover__item tools-popover__workspace"
      >
        <strong>{{ workspace.label }}</strong>
        <code>{{ workspace.path }}</code>
      </article>
      <div v-if="!store.workspaces.length" class="tools-popover__empty">
        No workspaces configured.
      </div>
    </div>
    <div
      v-show="activeTab === 'MCPs'"
      :id="panelId('MCPs')"
      role="tabpanel"
      :aria-labelledby="tabId('MCPs')"
      class="tools-popover__pane tools-popover__mcp"
    >
      <McpSettingsPanel :active="open" />
    </div>
    <div
      v-for="tab in ['Skills', 'Tools'] as const"
      v-show="activeTab === tab"
      :id="panelId(tab)"
      :key="tab"
      role="tabpanel"
      :aria-labelledby="tabId(tab)"
      class="tools-popover__pane"
    >
      <div v-if="loading" class="tools-popover__empty">Loading…</div>
      <div v-else-if="error" class="tools-popover__empty tools-popover__error">{{ error }}</div>
      <div v-else-if="!sessionId" class="tools-popover__empty">Chat is loading.</div>
      <template v-else-if="tab === 'Skills'">
        <article
          v-for="skill in resources.skills"
          :key="skill.filePath"
          class="tools-popover__item"
        >
          <strong>{{ skill.name }}</strong>
          <p>{{ skill.description }}</p>
          <code>{{ skill.filePath }}</code>
        </article>
        <div v-if="!resources.skills.length" class="tools-popover__empty">No skills available.</div>
      </template>
      <template v-else>
        <article v-for="tool in resources.tools" :key="tool.name" class="tools-popover__item">
          <strong>{{ tool.name }}</strong>
          <p>{{ tool.description }}</p>
        </article>
        <div v-if="!resources.tools.length" class="tools-popover__empty">No tools available.</div>
      </template>
    </div>
  </FullPopover>
</template>

<style scoped>
.tools-popover__pane {
  height: 100%;
  overflow-y: auto;
  background: var(--color-bg-app);
}

.tools-popover__mcp {
  padding: 1rem;
}

.tools-popover__item {
  padding: 0.85rem 1rem;
  border-bottom: 1px solid var(--color-border-soft);
  font-size: 0.86rem;
  overflow-wrap: anywhere;
}

.tools-popover__workspace {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.tools-popover__item p {
  margin: 0.25rem 0;
  white-space: pre-wrap;
}

.tools-popover__item code {
  color: var(--color-text-subtle);
  font-size: 0.75rem;
}

.tools-popover__empty {
  padding: 3rem 1rem;
  color: var(--color-text-subtle);
  text-align: center;
  font-size: 0.85rem;
}

.tools-popover__error {
  color: var(--color-error);
}
</style>
