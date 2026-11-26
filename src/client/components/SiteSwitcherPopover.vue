<script setup lang="ts">
import { Check, SquareStack } from "@lucide/vue";
import { onBeforeUnmount, ref, shallowRef } from "vue";
import { getSiteCatalog } from "@/client/lib/api";
import type { OwnerOutputs } from "@/shared/owner-api";
import type { SiteDescriptor } from "@/shared/types";
import BasePopover from "./BasePopover.vue";
import LoadingIndicator from "./LoadingIndicator.vue";
import SitePopover from "./SitePopover.vue";

const props = defineProps<{ popoverId: string }>();
const sites = shallowRef<SiteDescriptor[]>([]);
const activeSite = shallowRef<SiteDescriptor>();
const chooser = ref<InstanceType<typeof BasePopover>>();
const trigger = ref<HTMLButtonElement>();
const choosing = ref(false);
const loading = ref(false);
const error = ref("");
let request: AbortController | undefined;

async function loadCatalog(): Promise<void> {
  request = new AbortController();
  const { signal } = request;
  loading.value = true;
  error.value = "";
  try {
    const result = await getSiteCatalog(signal);
    if (signal.aborted) return;
    sites.value = result.sites;
    activeSite.value = result.sites[0];
  } catch (cause) {
    if (!signal.aborted) error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (!signal.aborted) loading.value = false;
  }
}

function handleToggle(event: Event): void {
  if ((event as ToggleEvent).newState === "open") {
    void loadCatalog();
  } else {
    request?.abort();
    choosing.value = false;
    activeSite.value = undefined;
    sites.value = [];
  }
}

function closeChooser(): void {
  chooser.value?.hidePopover();
  trigger.value?.focus({ preventScroll: true });
}

function selectSite(site: SiteDescriptor): void {
  closeChooser();
  if (activeSite.value?.id !== site.id) activeSite.value = site;
}

function onSiteOpened(result: OwnerOutputs["site.open"]): void {
  sites.value = result.sites;
  activeSite.value = result.site;
}

onBeforeUnmount(() => request?.abort());
</script>

<template>
  <SitePopover
    :popover-id="props.popoverId"
    :site="activeSite"
    label="Sites"
    :preview-inert="choosing"
    @toggle="handleToggle"
    @opened="onSiteOpened"
  >
    <template v-if="activeSite" #actions>
      <button
        ref="trigger"
        type="button"
        class="chrome-button chrome-button--icon"
        :popovertarget="`${props.popoverId}-chooser`"
        aria-label="Choose site"
        title="Choose site"
      >
        <SquareStack :size="18" />
      </button>
      <BasePopover
        :id="`${props.popoverId}-chooser`"
        ref="chooser"
        anchor-down
        :boundary-id="props.popoverId"
        class="site-chooser"
        @toggle="choosing = ($event as ToggleEvent).newState === 'open'"
        @keydown.esc.stop.prevent="closeChooser"
      >
        <ul class="site-chooser__list" role="list" aria-label="Available sites">
          <li v-for="site in sites" :key="site.id">
            <button
              type="button"
              class="site-chooser__item"
              :aria-current="site.id === activeSite.id ? 'page' : undefined"
              :autofocus="site.id === activeSite.id"
              @click="selectSite(site)"
            >
              <span class="site-chooser__check" aria-hidden="true">
                <Check v-if="site.id === activeSite.id" :size="16" />
              </span>
              {{ site.name }}
            </button>
          </li>
        </ul>
      </BasePopover>
    </template>
    <LoadingIndicator v-if="loading" class="site-switcher__status" label="Loading sites" />
    <p v-else-if="error" class="site-switcher__status site-switcher__error" role="alert">
      {{ error }}
    </p>
    <p v-else class="site-switcher__status">No sites yet.</p>
  </SitePopover>
</template>

<style scoped>
:global(.site-chooser) {
  width: 20rem;
  padding: 0.3rem;
  border: 1px solid var(--color-border-soft);
  border-radius: 0.6rem;
  background: var(--color-bg-overlay);
  color: var(--color-text);
  box-shadow: var(--color-shadow-popover);
  overflow: auto;
}

.site-chooser__list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.site-chooser__item {
  display: grid;
  grid-template-columns: 1rem minmax(0, 1fr);
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  height: auto;
  min-height: 2.75rem;
  padding: 0.6rem;
  border: 0;
  border-radius: 0.4rem;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  overflow-wrap: anywhere;
  cursor: pointer;
}

.site-chooser__check {
  display: flex;
}

.site-chooser__item[aria-current] {
  background: var(--color-chrome-hover);
  color: var(--color-link);
}

@media (hover: hover) {
  .site-chooser__item:hover {
    background: var(--color-chrome-hover);
    color: var(--color-link);
  }
}

.site-chooser__item:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}

.site-switcher__status {
  display: flex;
  justify-content: center;
  margin: 0;
  padding: 2rem 1rem;
  color: var(--color-text-muted);
  font-size: 0.85rem;
}

.site-switcher__error {
  color: var(--color-error);
}
</style>
