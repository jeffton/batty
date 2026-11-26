<script setup lang="ts">
import { Check, Copy } from "@lucide/vue";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import FullPopover from "./FullPopover.vue";
import { withBaseUrl } from "@/client/lib/base-url";
import { createSiteMessageHandler } from "@/client/lib/site-functions";
import type { SiteDescriptor } from "@/shared/types";

const props = defineProps<{ popoverId: string; site: SiteDescriptor }>();
const frame = ref<HTMLIFrameElement>();
const open = ref(false);
const revision = ref(0);
const copied = ref(false);
let copiedTimeout: number | undefined;

const url = computed(() => withBaseUrl(`/sites/${encodeURIComponent(props.site.id)}/`));
const absoluteUrl = computed(() => new URL(url.value, window.location.href).href);
const siteMessage = createSiteMessageHandler(() => (frame.value ? [frame.value] : []));

function handleToggle(event: Event): void {
  open.value = (event as ToggleEvent).newState === "open";
  if (open.value) revision.value++;
}

async function copyUrl(): Promise<void> {
  await navigator.clipboard.writeText(absoluteUrl.value);
  copied.value = true;
  window.clearTimeout(copiedTimeout);
  copiedTimeout = window.setTimeout(() => (copied.value = false), 1400);
}

watch(frame, (element, _previous, onCleanup) => {
  if (!element) return;
  window.addEventListener("message", siteMessage);
  onCleanup(() => window.removeEventListener("message", siteMessage));
});
onBeforeUnmount(() => window.clearTimeout(copiedTimeout));
</script>

<template>
  <FullPopover
    :popover-id="props.popoverId"
    :title="props.site.name"
    :subtitle="absoluteUrl"
    close-label="Close site"
    role="dialog"
    :aria-label="props.site.name"
    @toggle="handleToggle"
  >
    <template #header-actions>
      <slot name="header-actions" />
      <button
        type="button"
        class="chrome-button chrome-button--icon"
        title="Copy site URL"
        aria-label="Copy site URL"
        @click="copyUrl"
      >
        <Check v-if="copied" :size="16" />
        <Copy v-else :size="16" />
      </button>
    </template>
    <iframe
      v-if="open"
      ref="frame"
      class="site-popover__frame"
      :data-site-id="props.site.id"
      :src="`${url}?batty_preview=${revision}`"
      :title="props.site.name"
      sandbox="allow-downloads allow-forms allow-modals allow-popups allow-scripts"
    ></iframe>
  </FullPopover>
</template>

<style scoped>
.site-popover__frame {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: white;
}
</style>
