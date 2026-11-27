<script setup lang="ts">
import "./chooser-popover.css";
import { Check, SquareStack } from "@lucide/vue";
import { nextTick, onBeforeUnmount, ref, shallowRef } from "vue";
import { getLatestSite, getSiteCatalog } from "@/client/lib/api";
import type { SiteDescriptor } from "@/shared/types";
import { setPopoverInitialFocus } from "@/client/lib/popover-focus";
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
const catalogLoading = ref(false);
const catalogError = ref("");
let request: AbortController | undefined;
let catalogRequest: AbortController | undefined;
let focusChoiceOnLoad = false;

function handleChooserClick(event: MouseEvent): void {
  focusChoiceOnLoad = event.detail === 0;
  setPopoverInitialFocus(event);
}

async function loadLatest(): Promise<void> {
  request = new AbortController();
  const { signal } = request;
  loading.value = true;
  error.value = "";
  try {
    const site = await getLatestSite(signal);
    if (!signal.aborted) activeSite.value = site ?? undefined;
  } catch (cause) {
    if (!signal.aborted) error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (!signal.aborted) loading.value = false;
  }
}

function handleToggle(event: Event): void {
  if ((event as ToggleEvent).newState === "open") {
    void loadLatest();
  } else {
    request?.abort();
    catalogRequest?.abort();
    choosing.value = false;
    activeSite.value = undefined;
    sites.value = [];
  }
}

async function handleChooserToggle(event: Event): Promise<void> {
  choosing.value = (event as ToggleEvent).newState === "open";
  if (!choosing.value) {
    catalogRequest?.abort();
    return;
  }

  catalogRequest = new AbortController();
  const { signal } = catalogRequest;
  catalogLoading.value = true;
  catalogError.value = "";
  try {
    const result = await getSiteCatalog(signal);
    if (signal.aborted) return;
    const firstLoad = sites.value.length === 0;
    sites.value = result.sites;
    if (firstLoad && focusChoiceOnLoad) await focusLoadedChoice(signal);
  } catch (cause) {
    if (!signal.aborted)
      catalogError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (!signal.aborted) catalogLoading.value = false;
  }
}

async function focusLoadedChoice(signal: AbortSignal): Promise<void> {
  await nextTick();
  if (signal.aborted) return;
  const menu = chooser.value?.element;
  const focused = document.activeElement;
  if (focused === document.body || focused === trigger.value || focused === menu)
    menu
      ?.querySelector<HTMLButtonElement>("[data-popover-initial-focus]")
      ?.focus({ preventScroll: true });
}

function closeChooser(): void {
  chooser.value?.hidePopover();
  trigger.value?.focus({ preventScroll: true });
}

function selectSite(site: SiteDescriptor): void {
  closeChooser();
  if (activeSite.value?.id !== site.id) activeSite.value = site;
}

onBeforeUnmount(() => {
  request?.abort();
  catalogRequest?.abort();
});
</script>

<template>
  <SitePopover
    :popover-id="props.popoverId"
    :site="activeSite"
    label="Sites"
    :preview-inert="choosing"
    @toggle="handleToggle"
  >
    <template v-if="activeSite" #actions>
      <button
        ref="trigger"
        type="button"
        class="chrome-button chrome-button--icon"
        :popovertarget="`${props.popoverId}-chooser`"
        aria-label="Choose site"
        title="Choose site"
        @click="handleChooserClick"
      >
        <SquareStack :size="18" />
      </button>
      <BasePopover
        :id="`${props.popoverId}-chooser`"
        ref="chooser"
        anchor-down
        align-viewport-right
        :boundary-id="`${props.popoverId}-body`"
        class="chooser-popover"
        @toggle="handleChooserToggle"
        @keydown.esc.stop.prevent="closeChooser"
      >
        <LoadingIndicator
          v-if="catalogLoading && !sites.length"
          class="site-switcher__status"
          label="Loading sites"
        />
        <p v-if="catalogError" class="site-switcher__status site-switcher__error" role="alert">
          {{ catalogError }}
        </p>
        <ul v-if="sites.length" class="site-chooser__list" role="list" aria-label="Available sites">
          <li v-for="site in sites" :key="site.id" class="chooser-popover__row">
            <button
              type="button"
              class="chooser-popover__select"
              :aria-current="site.id === activeSite.id ? 'page' : undefined"
              :data-popover-initial-focus="site.id === activeSite.id ? '' : undefined"
              @click="selectSite(site)"
            >
              <span class="chooser-popover__current" aria-hidden="true">
                <Check v-if="site.id === activeSite.id" :size="16" />
              </span>
              <span class="chooser-popover__label"><strong>{{ site.name }}</strong></span>
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
.site-chooser__list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.site-chooser__list .chooser-popover__current {
  min-width: 0;
}

.site-chooser__list .chooser-popover__current svg {
  max-width: 100%;
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
