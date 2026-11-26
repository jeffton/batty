<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { SiteDescriptor } from "@/shared/types";

const props = defineProps<{
  idPrefix: string;
  recent: SiteDescriptor[];
  activeId: string;
  showingMore: boolean;
  hasUnvisited: boolean;
}>();
const visibleCount = defineModel<number>("visibleCount", { required: true });
const emit = defineEmits<{ select: [site: SiteDescriptor]; more: [] }>();
const host = ref<HTMLElement>();
const ruler = ref<HTMLElement>();
const focusedTab = ref<string>();
const visible = computed(() => props.recent.slice(0, Math.max(1, visibleCount.value)));
const hasMore = computed(() => props.hasUnvisited || visible.value.length < props.recent.length);
const activeTab = computed(() => (props.showingMore ? "more" : props.activeId));
const tabOrder = computed(() => [
  ...visible.value.map((site) => site.id),
  ...(hasMore.value ? ["more"] : []),
]);

function tabId(id: string): string {
  return `${props.idPrefix}-${id}-tab`;
}

function measure(): void {
  const width = host.value?.clientWidth ?? 0;
  if (!width || !ruler.value) return;
  const widths = Array.from(ruler.value.children).map(
    (element) => element.getBoundingClientRect().width,
  );
  const more = widths.pop()!;
  const total = widths.reduce((sum, width) => sum + width, 0);
  if (!props.hasUnvisited && total <= width) {
    visibleCount.value = widths.length;
    return;
  }
  let available = width - more;
  let fit = 0;
  for (const width of widths) {
    if (width > available) break;
    available -= width;
    fit++;
  }
  visibleCount.value = Math.max(1, fit);
}

watch(
  [host, ruler],
  ([host, ruler], _previous, onCleanup) => {
    if (!host || !ruler) return;
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    observer.observe(ruler);
    onCleanup(() => observer.disconnect());
  },
  { flush: "post" },
);
watch([() => props.recent, () => props.hasUnvisited], measure, { flush: "post" });

function handleKeydown(event: KeyboardEvent, id: string): void {
  const order = tabOrder.value;
  const index = order.indexOf(id);
  const next =
    event.key === "ArrowRight"
      ? (index + 1) % order.length
      : event.key === "ArrowLeft"
        ? (index + order.length - 1) % order.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? order.length - 1
            : undefined;
  if (next === undefined) return;
  event.preventDefault();
  document.getElementById(tabId(order[next]!))?.focus({ preventScroll: true });
}

function tabIndex(id: string): number {
  const focused = focusedTab.value;
  const current = focused && tabOrder.value.includes(focused) ? focused : activeTab.value;
  return id === current ? 0 : -1;
}
</script>

<template>
  <div
    ref="host"
    class="site-tabs"
    role="tablist"
    aria-label="Recent sites"
    @focusout="focusedTab = undefined"
  >
    <button
      v-for="site in visible"
      :id="tabId(site.id)"
      :key="site.id"
      type="button"
      class="site-tab"
      role="tab"
      :title="site.name"
      :aria-controls="`${props.idPrefix}-panel`"
      :aria-selected="activeTab === site.id"
      :tabindex="tabIndex(site.id)"
      @click="emit('select', site)"
      @focus="focusedTab = site.id"
      @keydown="handleKeydown($event, site.id)"
    >
      <span>{{ site.name }}</span>
    </button>
    <button
      v-if="hasMore"
      :id="tabId('more')"
      type="button"
      class="site-tab site-tab--more"
      role="tab"
      :aria-controls="`${props.idPrefix}-panel`"
      :aria-selected="props.showingMore"
      :tabindex="tabIndex('more')"
      @click="emit('more')"
      @focus="focusedTab = 'more'"
      @keydown="handleKeydown($event, 'more')"
    >
      More sites
    </button>

    <div ref="ruler" class="site-tabs__ruler" aria-hidden="true">
      <span v-for="site in props.recent" :key="site.id" class="site-tab">{{ site.name }}</span>
      <span class="site-tab site-tab--more">More sites</span>
    </div>
  </div>
</template>

<style scoped>
.site-tabs {
  position: relative;
  display: flex;
  min-width: 0;
  margin-inline: 0.5rem;
}

.site-tabs__ruler {
  position: absolute;
  display: flex;
  width: max-content;
  inset-block-start: 0;
  inset-inline-start: 0;
  visibility: hidden;
  pointer-events: none;
}

.site-tab {
  display: inline-flex;
  flex: 0 1 auto;
  align-items: center;
  min-width: var(--button-size);
  min-height: var(--button-size);
  padding: 0.45rem 0.8rem;
  border: 0;
  border-bottom: 3px solid transparent;
  border-radius: 0.5rem 0.5rem 0 0;
  background: transparent;
  color: var(--color-text-subtle);
  font-family: inherit;
  font-size: 0.86rem;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
}

.site-tab span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.site-tab--more {
  flex-shrink: 0;
}

.site-tab[aria-selected="true"] {
  border-bottom-color: var(--color-accent);
  color: var(--color-link);
}

@media (hover: hover) {
  .site-tab:hover {
    background: var(--color-chrome-hover);
    color: var(--color-link);
  }
}

.site-tab:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}
</style>
