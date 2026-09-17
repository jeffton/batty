<script setup lang="ts">
import { Check, Copy, ExternalLink } from "@lucide/vue";
import { computed, onBeforeUnmount, ref } from "vue";
import FullPopover from "@/client/components/FullPopover.vue";
import { setSitePublic } from "@/client/lib/api";
import type { SiteDescriptor } from "@/shared/types";

const props = defineProps<{ sites: SiteDescriptor[] }>();
const publicById = ref<Record<string, boolean>>({});
const savingId = ref<string>();
const copiedId = ref<string>();
const previewRevisionById = ref<Record<string, number>>({});
let copiedTimeout: number | undefined;

const displayedSites = computed(() =>
  props.sites.map((site) => ({
    ...site,
    public: publicById.value[site.id] ?? site.public,
  })),
);

function popoverId(siteId: string): string {
  return `site-preview-${siteId.replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
}

function absoluteUrl(url: string): string {
  return new URL(url, window.location.href).toString();
}

function previewUrl(site: SiteDescriptor): string {
  const revision = previewRevisionById.value[site.id] ?? 0;
  if (revision === 0) return site.url;
  const separator = site.url.includes("?") ? "&" : "?";
  return `${site.url}${separator}batty_preview=${revision}`;
}

function refreshPreview(site: SiteDescriptor, event: Event): void {
  if ((event as ToggleEvent).newState !== "open") return;
  previewRevisionById.value = {
    ...previewRevisionById.value,
    [site.id]: (previewRevisionById.value[site.id] ?? 0) + 1,
  };
}

async function copyUrl(site: SiteDescriptor): Promise<void> {
  await navigator.clipboard.writeText(absoluteUrl(site.url));
  copiedId.value = site.id;
  if (copiedTimeout !== undefined) window.clearTimeout(copiedTimeout);
  copiedTimeout = window.setTimeout(() => {
    copiedId.value = undefined;
    copiedTimeout = undefined;
  }, 1400);
}

async function togglePublic(site: SiteDescriptor, event: Event): Promise<void> {
  const isPublic = (event.target as HTMLInputElement).checked;
  savingId.value = site.id;
  try {
    const updated = await setSitePublic(site.id, isPublic);
    publicById.value = { ...publicById.value, [site.id]: updated.public };
  } catch (error) {
    publicById.value = { ...publicById.value, [site.id]: site.public };
    throw error;
  } finally {
    savingId.value = undefined;
  }
}

onBeforeUnmount(() => {
  if (copiedTimeout !== undefined) window.clearTimeout(copiedTimeout);
});
</script>

<template>
  <div class="shared-sites">
    <article v-for="site in displayedSites" :key="site.id" class="shared-sites__card">
      <div class="shared-sites__meta">
        <strong>{{ site.name }}</strong>
        <span>{{ site.public ? "Public site" : "Private site" }}</span>
      </div>
      <button type="button" class="shared-sites__open" :popovertarget="popoverId(site.id)">
        <ExternalLink :size="15" />
        Open site
      </button>

      <FullPopover
        :popover-id="popoverId(site.id)"
        :title="site.name"
        :subtitle="absoluteUrl(site.url)"
        @toggle="refreshPreview(site, $event)"
      >
        <template #header-actions>
          <label class="shared-sites__switch">
            <input
              type="checkbox"
              role="switch"
              :checked="site.public"
              :disabled="savingId === site.id"
              @change="togglePublic(site, $event)"
            />
            <span class="shared-sites__switch-track" aria-hidden="true"></span>
            Public
          </label>
          <button
            type="button"
            class="shared-sites__header-btn"
            title="Copy site URL"
            aria-label="Copy site URL"
            @click="copyUrl(site)"
          >
            <Check v-if="copiedId === site.id" :size="16" />
            <Copy v-else :size="16" />
          </button>
        </template>
        <iframe
          class="shared-sites__frame"
          :src="previewUrl(site)"
          :title="site.name"
          sandbox="allow-downloads allow-forms allow-modals allow-popups allow-scripts"
        ></iframe>
      </FullPopover>
    </article>
  </div>
</template>

<style scoped>
.shared-sites {
  display: grid;
  gap: 0.6rem;
}

.shared-sites__card {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.7rem;
  border: 1px solid var(--color-border);
  border-radius: 0.65rem;
  background: var(--color-bg-panel);
}

.shared-sites__meta {
  display: grid;
  gap: 0.1rem;
  min-width: 0;
  margin-right: auto;
}

.shared-sites__meta strong {
  overflow-wrap: anywhere;
}

.shared-sites__meta span {
  color: var(--color-text-muted);
  font-size: 0.82rem;
}

.shared-sites__open,
.shared-sites__header-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  min-height: 2rem;
  padding: 0.35rem 0.65rem;
  border: 1px solid var(--color-border-soft);
  border-radius: 0.5rem;
  background: var(--color-bg-panel);
  color: var(--color-text);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.shared-sites__header-btn {
  width: 2rem;
  padding: 0;
}

.shared-sites__switch {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
}

.shared-sites__switch input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.shared-sites__switch-track {
  position: relative;
  width: 2rem;
  height: 1.1rem;
  border-radius: 999px;
  background: var(--color-border-strong);
  transition: background 120ms ease;
}

.shared-sites__switch-track::after {
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

.shared-sites__switch input:checked + .shared-sites__switch-track {
  background: var(--color-accent);
}

.shared-sites__switch input:checked + .shared-sites__switch-track::after {
  transform: translateX(0.9rem);
}

.shared-sites__switch input:focus-visible + .shared-sites__switch-track {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

.shared-sites__switch input:disabled + .shared-sites__switch-track {
  opacity: 0.55;
}

.shared-sites__frame {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: white;
}

@media (hover: hover) {
  .shared-sites__open:hover,
  .shared-sites__header-btn:hover {
    background: var(--color-bg-elevated-soft);
  }
}
</style>
