<script setup lang="ts">
import "./chooser-popover.css";
import { Check, SquareStack } from "@lucide/vue";
import { onBeforeUnmount, ref, shallowRef } from "vue";
import { getSiteCatalog } from "@/client/lib/api";
import type { OwnerOutputs } from "@/shared/owner-api";
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
        @click="setPopoverInitialFocus"
      >
        <SquareStack :size="18" />
      </button>
      <BasePopover
        :id="`${props.popoverId}-chooser`"
        ref="chooser"
        anchor-down
        align-viewport-right
        :boundary-id="props.popoverId"
        class="chooser-popover"
        @toggle="choosing = ($event as ToggleEvent).newState === 'open'"
        @keydown.esc.stop.prevent="closeChooser"
      >
        <ul class="site-chooser__list" role="list" aria-label="Available sites">
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

.site-chooser__list .chooser-popover__label strong {
  white-space: normal;
  overflow-wrap: anywhere;
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
