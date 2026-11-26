<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { getSiteCatalog } from "@/client/lib/api";
import type { OwnerOutputs } from "@/shared/owner-api";
import type { SiteDescriptor } from "@/shared/types";
import LoadingIndicator from "./LoadingIndicator.vue";
import SitePopover from "./SitePopover.vue";
import SiteSwitcherTabs from "./SiteSwitcherTabs.vue";

const props = defineProps<{ popoverId: string }>();
const catalog = shallowRef<OwnerOutputs["site.catalog"]>({ sites: [], recentSiteIds: [] });
const activeSite = shallowRef<SiteDescriptor>();
const showingMore = ref(false);
const loading = ref(false);
const error = ref("");
const visibleCount = ref(0);
let request: AbortController | undefined;

const recent = computed(() => {
  const byId = new Map(catalog.value.sites.map((site) => [site.id, site]));
  return catalog.value.recentSiteIds.flatMap((id) => {
    const site = byId.get(id);
    return site ? [site] : [];
  });
});
const hasUnvisited = computed(() => catalog.value.sites.length > recent.value.length);
const showTabs = computed(() => !!activeSite.value && catalog.value.sites.length > 1);
const remaining = computed(() => {
  const visible = new Set(
    recent.value.slice(0, Math.max(1, visibleCount.value)).map((site) => site.id),
  );
  return catalog.value.sites.filter((site) => !visible.has(site.id));
});
const panelLabelledBy = computed(() =>
  showTabs.value
    ? `${props.popoverId}-${showingMore.value ? "more" : activeSite.value!.id}-tab`
    : undefined,
);

watch(remaining, (sites) => {
  if (!sites.length && activeSite.value) showingMore.value = false;
});

function tab(id?: string): HTMLElement | null {
  return id ? document.getElementById(`${props.popoverId}-${id}-tab`) : null;
}

function focusControl(preferred?: string): void {
  const popover = document.getElementById(props.popoverId);
  if (!popover?.matches(":popover-open")) return;
  const control =
    tab(preferred) ??
    popover.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ??
    popover.querySelector<HTMLElement>(".full-popover__close");
  control?.focus({ preventScroll: true });
}

watch([visibleCount, remaining], async () => {
  const popover = document.getElementById(props.popoverId);
  const focused = document.activeElement;
  if (!focused || !popover?.contains(focused)) return;
  await nextTick();
  if (document.activeElement === document.body && !focused.isConnected) {
    focusControl(focused.getAttribute("role") === "tab" ? "more" : undefined);
  }
});

async function loadCatalog(): Promise<void> {
  request = new AbortController();
  const { signal } = request;
  loading.value = true;
  error.value = "";
  try {
    const result = await getSiteCatalog(signal);
    if (signal.aborted) return;
    catalog.value = result;
    activeSite.value = recent.value[0];
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
    activeSite.value = undefined;
    showingMore.value = false;
    visibleCount.value = 0;
    catalog.value = { sites: [], recentSiteIds: [] };
  }
}

async function selectSite(site: SiteDescriptor): Promise<void> {
  if (activeSite.value?.id !== site.id) {
    activeSite.value = site;
    catalog.value = {
      ...catalog.value,
      recentSiteIds: [site.id, ...catalog.value.recentSiteIds.filter((id) => id !== site.id)],
    };
  }
  showingMore.value = false;
  await nextTick();
  focusControl(site.id);
}

function onSiteOpened(result: OwnerOutputs["site.open"]): void {
  catalog.value = result;
  activeSite.value = result.site;
}

onBeforeUnmount(() => request?.abort());
</script>

<template>
  <SitePopover
    :popover-id="props.popoverId"
    :site="activeSite"
    label="Sites"
    :show-site="!showingMore"
    :panel-id="`${props.popoverId}-panel`"
    :panel-labelled-by="panelLabelledBy"
    @toggle="handleToggle"
    @opened="onSiteOpened"
  >
    <template v-if="activeSite && showTabs" #tabs>
      <SiteSwitcherTabs
        v-model:visible-count="visibleCount"
        :id-prefix="props.popoverId"
        :recent="recent"
        :active-id="activeSite.id"
        :showing-more="showingMore"
        :has-unvisited="hasUnvisited"
        @select="selectSite"
        @more="showingMore = true"
      />
    </template>
    <div class="site-switcher">
      <LoadingIndicator v-if="loading" class="site-switcher__status" label="Loading sites" />
      <p v-else-if="error" class="site-switcher__status site-switcher__error" role="alert">
        {{ error }}
      </p>
      <ul
        v-else-if="remaining.length"
        class="site-switcher__list"
        role="list"
        aria-label="Available sites"
      >
        <li v-for="site in remaining" :key="site.id">
          <button type="button" class="site-switcher__choice" @click="selectSite(site)">
            {{ site.name }}
          </button>
        </li>
      </ul>
      <p v-else class="site-switcher__status">No sites yet.</p>
    </div>
  </SitePopover>
</template>

<style scoped>
.site-switcher {
  height: 100%;
  overflow-y: auto;
  overscroll-behavior: contain;
  background: var(--color-bg-app);
}

.site-switcher__list {
  max-width: 60rem;
  margin: 0 auto;
  padding: 0;
  list-style: none;
}

.site-switcher__choice {
  display: block;
  width: 100%;
  height: auto;
  padding: 0.65rem 1rem;
  border: 0;
  border-bottom: 1px solid var(--color-border-soft);
  background: transparent;
  color: var(--color-text);
  font: inherit;
  text-align: left;
  overflow-wrap: anywhere;
  cursor: pointer;
}

@media (hover: hover) {
  .site-switcher__choice:hover {
    background: var(--color-chrome-hover);
  }
}

.site-switcher__choice:focus-visible {
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
