<script setup lang="ts">
import { Check, Copy } from "@lucide/vue";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import FullPopover from "./FullPopover.vue";
import { withBaseUrl } from "@/client/lib/base-url";
import { openSite } from "@/client/lib/api";
import { createSiteMessageHandler } from "@/client/lib/site-functions";
import {
  confirmedSitePublic,
  loadSiteVisibility,
  saveSiteVisibility,
  savingSiteVisibility,
} from "@/client/lib/site-visibility";
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
const copied = ref(false);
const visibilityReady = ref(false);
const visibilityError = ref("");
const openError = ref("");
const siteId = computed(() => props.site?.id);
const isPublic = computed(() =>
  siteId.value ? (confirmedSitePublic(siteId.value) ?? false) : false,
);
const saving = computed(() => !!siteId.value && savingSiteVisibility.has(siteId.value));
let copiedTimeout: number | undefined;

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
  visibilityReady.value = false;
  visibilityError.value = "";
  openError.value = "";
  if (!isOpen || !id) return;
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  void refreshVisibility(id, controller.signal);
  void recordOpen(id, controller.signal);
});

async function refreshVisibility(id: string, signal: AbortSignal): Promise<void> {
  try {
    await loadSiteVisibility(id, signal);
    if (!signal.aborted) visibilityReady.value = true;
  } catch (error) {
    if (!signal.aborted)
      visibilityError.value = `Could not load site visibility: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function recordOpen(id: string, signal: AbortSignal): Promise<void> {
  try {
    const result = await openSite(id);
    if (!signal.aborted) emit("opened", result);
  } catch (error) {
    if (!signal.aborted)
      openError.value = `Could not save recent site: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function togglePublic(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const requestedPublic = input.checked;
  input.checked = isPublic.value;
  const preview = revision.value;
  const id = props.site!.id;
  visibilityError.value = "";
  try {
    await saveSiteVisibility(id, requestedPublic);
  } catch (error) {
    if (open.value && revision.value === preview && siteId.value === id) {
      visibilityError.value = `Could not change site visibility: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}

async function copyUrl(): Promise<void> {
  await navigator.clipboard.writeText(absoluteUrl.value!);
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
    :title="props.site?.name ?? 'Sites'"
    :subtitle="absoluteUrl"
    :close-label="props.label ? 'Close sites' : 'Close site'"
    role="dialog"
    :aria-label="props.label ?? props.site?.name"
    @toggle="handleToggle"
  >
    <template v-if="props.site" #header-actions>
      <slot name="actions" />
      <label
        class="site-popover__switch"
        :aria-busy="(!visibilityReady && !visibilityError) || saving"
      >
        <input
          type="checkbox"
          role="switch"
          :checked="visibilityReady && isPublic"
          :disabled="!visibilityReady || saving"
          :indeterminate="!visibilityReady"
          @change="togglePublic"
        />
        <span class="site-popover__switch-track" aria-hidden="true"></span>
        Public
      </label>
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
    <div v-if="open" class="site-popover__panel">
      <div v-if="props.site" class="site-popover__content">
        <div v-if="openError || visibilityError" class="site-popover__errors">
          <p v-if="openError" role="alert" class="site-popover__error">{{ openError }}</p>
          <p v-if="visibilityError" role="alert" class="site-popover__error">
            {{ visibilityError }}
          </p>
        </div>
        <iframe
          :key="props.site.id"
          ref="frame"
          class="site-popover__frame"
          :data-site-id="props.site.id"
          :src="`${url}?batty_preview=${revision}`"
          :title="props.site.name"
          :inert="props.previewInert"
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

.site-popover__switch {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
}

.site-popover__switch input {
  position: absolute;
  z-index: 1;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: inherit;
}

.site-popover__switch-track {
  position: relative;
  width: 2rem;
  height: 1.1rem;
  border-radius: 999px;
  background: var(--color-border-strong);
  transition: background 120ms ease;
}

.site-popover__switch-track::after {
  position: absolute;
  top: 0.15rem;
  left: 0.15rem;
  width: 0.8rem;
  height: 0.8rem;
  border-radius: 50%;
  background: var(--color-bg-overlay);
  box-shadow: 0 1px 2px color-mix(in srgb, black 30%, transparent);
  content: "";
  transition: transform 120ms ease;
}

.site-popover__switch input:checked + .site-popover__switch-track {
  background: var(--color-accent);
}

.site-popover__switch input:checked + .site-popover__switch-track::after {
  transform: translateX(0.9rem);
}

.site-popover__switch input:focus-visible + .site-popover__switch-track {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

.site-popover__switch input:disabled + .site-popover__switch-track {
  opacity: 0.55;
}

.site-popover__switch input:indeterminate + .site-popover__switch-track::after {
  display: none;
}
</style>
