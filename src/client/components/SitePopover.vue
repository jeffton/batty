<script setup lang="ts">
import { computed, ref, watch } from "vue";
import FullPopover from "./FullPopover.vue";
import SiteSharePopover from "./SiteSharePopover.vue";
import { withBaseUrl } from "@/client/lib/base-url";
import { openSite } from "@/client/lib/api";
import { createSiteMessageHandler } from "@/client/lib/site-functions";
import type { SiteDescriptor } from "@/shared/types";
import type { OwnerOutputs } from "@/shared/owner-api";

const props = defineProps<{
  popoverId: string;
  site?: SiteDescriptor;
  label?: string;
  previewInert?: boolean;
}>();
const emit = defineEmits<{
  toggle: [event: Event];
  opened: [catalog: OwnerOutputs["site.open"]];
}>();
const frame = ref<HTMLIFrameElement>();
const open = ref(false);
const revision = ref(0);
const sharing = ref(false);
const openError = ref("");
const siteId = computed(() => props.site?.id);

const url = computed(() =>
  siteId.value ? withBaseUrl(`/sites/${encodeURIComponent(siteId.value)}/`) : undefined,
);
const absoluteUrl = computed(() =>
  url.value ? new URL(url.value, window.location.href).href : undefined,
);
const siteMessage = createSiteMessageHandler(() => (frame.value ? [frame.value] : []));

function handleToggle(event: Event): void {
  open.value = (event as ToggleEvent).newState === "open";
  if (open.value) revision.value++;
  emit("toggle", event);
}

watch([open, siteId], ([isOpen, id], _previous, onCleanup) => {
  sharing.value = false;
  openError.value = "";
  if (!isOpen || !id) return;
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  void recordOpen(id, controller.signal);
});

async function recordOpen(id: string, signal: AbortSignal): Promise<void> {
  try {
    const result = await openSite(id);
    if (!signal.aborted) emit("opened", result);
  } catch (error) {
    if (!signal.aborted)
      openError.value = `Could not save recent site: ${error instanceof Error ? error.message : String(error)}`;
  }
}

watch(frame, (element, _previous, onCleanup) => {
  if (!element) return;
  window.addEventListener("message", siteMessage);
  onCleanup(() => window.removeEventListener("message", siteMessage));
});
</script>

<template>
  <FullPopover
    :popover-id="props.popoverId"
    :title="props.site?.name ?? 'Sites'"
    :subtitle="absoluteUrl"
    :close-label="props.label ? 'Close sites' : 'Close site'"
    role="dialog"
    :aria-label="props.label ?? props.site?.name"
    @toggle="handleToggle"
  >
    <template v-if="props.site" #header-actions>
      <slot name="actions" />
      <SiteSharePopover
        v-if="open"
        :key="props.site.id"
        :popover-id="props.popoverId"
        :site-id="props.site.id"
        :url="absoluteUrl!"
        @toggle="sharing = $event"
      />
    </template>
    <div v-if="open" class="site-popover__panel">
      <div v-if="props.site" class="site-popover__content">
        <p v-if="openError" role="alert" class="site-popover__error">{{ openError }}</p>
        <iframe
          :key="props.site.id"
          ref="frame"
          class="site-popover__frame"
          :data-site-id="props.site.id"
          :src="`${url}?batty_preview=${revision}`"
          :title="props.site.name"
          :inert="props.previewInert || sharing"
          sandbox="allow-downloads allow-forms allow-modals allow-popups allow-scripts"
        ></iframe>
      </div>
      <slot v-else />
    </div>
  </FullPopover>
</template>

<style scoped>
.site-popover__frame {
  display: block;
  grid-row: 2;
  width: 100%;
  height: 100%;
  border: 0;
  background: white;
}

.site-popover__panel {
  height: 100%;
  min-height: 0;
}

.site-popover__content {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  height: 100%;
}

.site-popover__error {
  margin: 0;
  padding: 0.5rem 1rem;
  color: var(--color-text);
  background: var(--color-bg-panel);
}
</style>
