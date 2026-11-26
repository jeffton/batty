<script setup lang="ts">
import { Check, Copy, Share } from "@lucide/vue";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import BasePopover from "./BasePopover.vue";
import {
  confirmedSitePublic,
  loadSiteVisibility,
  saveSiteVisibility,
  savingSiteVisibility,
} from "@/client/lib/site-visibility";

const props = defineProps<{ popoverId: string; siteId: string; url: string }>();
const emit = defineEmits<{ toggle: [open: boolean] }>();
const popover = ref<InstanceType<typeof BasePopover>>();
const trigger = ref<HTMLButtonElement>();
const open = ref(false);
const ready = ref(false);
const visibilityError = ref("");
const copied = ref(false);
const copyError = ref(false);
const isPublic = computed(() => confirmedSitePublic(props.siteId) ?? false);
const saving = computed(() => savingSiteVisibility.has(props.siteId));
let session: AbortController | undefined;
let copiedTimeout: number | undefined;

function handleToggle(event: Event): void {
  open.value = (event as ToggleEvent).newState === "open";
  emit("toggle", open.value);
}

function close(): void {
  popover.value?.hidePopover();
  trigger.value?.focus({ preventScroll: true });
}

watch(open, async (isOpen, _previous, onCleanup) => {
  ready.value = false;
  visibilityError.value = "";
  copied.value = false;
  copyError.value = false;
  window.clearTimeout(copiedTimeout);
  if (!isOpen) return;
  const controller = new AbortController();
  session = controller;
  const { signal } = controller;
  onCleanup(() => controller.abort());
  try {
    await loadSiteVisibility(props.siteId, signal);
    if (!signal.aborted) ready.value = true;
  } catch (error) {
    if (!signal.aborted)
      visibilityError.value = `Could not load site visibility: ${error instanceof Error ? error.message : String(error)}`;
  }
});

async function togglePublic(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const requested = input.checked;
  input.checked = isPublic.value;
  const signal = session!.signal;
  visibilityError.value = "";
  try {
    await saveSiteVisibility(props.siteId, requested);
  } catch (error) {
    if (!signal.aborted)
      visibilityError.value = `Could not change site visibility: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function copyLink(): Promise<void> {
  const signal = session!.signal;
  copyError.value = false;
  try {
    await navigator.clipboard.writeText(props.url);
    if (signal.aborted) return;
    copied.value = true;
    window.clearTimeout(copiedTimeout);
    copiedTimeout = window.setTimeout(() => (copied.value = false), 1400);
  } catch {
    if (!signal.aborted) {
      copied.value = false;
      copyError.value = true;
    }
  }
}

onBeforeUnmount(() => window.clearTimeout(copiedTimeout));
</script>

<template>
  <button
    ref="trigger"
    type="button"
    class="chrome-button chrome-button--icon"
    :popovertarget="`${props.popoverId}-share`"
    aria-label="Share site"
    title="Share site"
  >
    <Share :size="18" />
  </button>
  <BasePopover
    :id="`${props.popoverId}-share`"
    ref="popover"
    anchor-down
    :boundary-id="props.popoverId"
    class="site-share"
    role="group"
    aria-label="Share site"
    @toggle="handleToggle"
    @keydown.esc.stop.prevent="close"
  >
    <button type="button" class="site-share__copy" autofocus @click="copyLink">
      <Check v-if="copied" :size="16" aria-hidden="true" />
      <Copy v-else :size="16" aria-hidden="true" />
      <span aria-live="polite">{{ copied ? "Copied" : "Copy link" }}</span>
    </button>
    <p v-if="copyError" class="site-share__error" role="alert">Could not copy link</p>
    <label class="site-share__switch" :aria-busy="(!ready && !visibilityError) || saving">
      Public
      <input
        type="checkbox"
        role="switch"
        :checked="ready && isPublic"
        :disabled="!ready || saving"
        :indeterminate="!ready"
        @change="togglePublic"
      />
      <span class="site-share__track" aria-hidden="true"></span>
    </label>
    <p v-if="visibilityError" class="site-share__error" role="alert">{{ visibilityError }}</p>
  </BasePopover>
</template>

<style scoped>
:global(.site-share) {
  width: 12rem;
  padding: 0.3rem;
  border: 1px solid var(--color-border-soft);
  border-radius: 0.6rem;
  background: var(--color-bg-overlay);
  color: var(--color-text);
  box-shadow: var(--color-shadow-popover);
  overflow: auto;
}

.site-share__copy,
.site-share__switch {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  min-height: 2.75rem;
  padding: 0.6rem;
  border: 0;
  border-radius: 0.4rem;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.site-share__switch {
  position: relative;
  justify-content: space-between;
}

@media (hover: hover) {
  .site-share__copy:hover,
  .site-share__switch:hover {
    background: var(--color-chrome-hover);
  }
}

.site-share__copy:focus-visible,
.site-share__switch:has(input:focus-visible) {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}

.site-share__switch input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: inherit;
}

.site-share__switch input:disabled {
  cursor: default;
}

.site-share__track {
  position: relative;
  width: 2rem;
  height: 1.1rem;
  border-radius: 999px;
  background: var(--color-border-strong);
  pointer-events: none;
  transition: background 120ms ease;
}

.site-share__track::after {
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

input:checked + .site-share__track {
  background: var(--color-accent);
}

input:checked + .site-share__track::after {
  transform: translateX(0.9rem);
}

input:disabled + .site-share__track {
  opacity: 0.55;
}

input:indeterminate + .site-share__track::after {
  display: none;
}

.site-share__error {
  margin: 0;
  padding: 0 0.6rem 0.6rem;
  color: var(--color-error);
  font-size: 0.8rem;
  overflow-wrap: anywhere;
}
</style>
