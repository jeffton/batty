<script setup lang="ts">
import { Virtualizer } from "virtua/vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import type { ArtifactLibraryItem, ArtifactLibraryResponse } from "@/shared/artifact-library";
import {
  ArtifactCatalogChanged,
  getArtifacts,
  setArtifactStar,
} from "@/client/lib/artifact-library";
import FullPopover from "./FullPopover.vue";
import ArtifactLibraryRow from "./ArtifactLibraryRow.vue";
import LoadingIndicator from "./LoadingIndicator.vue";

const props = defineProps<{ popoverId: string }>();
const artifacts = shallowRef<ArtifactLibraryItem[]>([]);
const viewport = ref<HTMLElement>();
const pageEnd = ref<HTMLElement>();
const nextCursor = ref<string>();
const pageRequest = shallowRef<AbortController>();
const open = ref(false);
const saving = ref(false);
const error = ref("");
const pageError = ref("");
const focusedRef = ref<string>();
const previewRef = ref<string>();
const deferredPage = shallowRef<{ page: ArtifactLibraryResponse; fromStar: boolean }>();

const keptRows = computed(() =>
  [...new Set([focusedRef.value, previewRef.value].filter(Boolean))]
    .map((ref) => artifacts.value.findIndex((item) => item.ref === ref))
    .filter((index) => index !== -1),
);

function rowAttributes({ item }: { item: ArtifactLibraryItem }) {
  return { "data-artifact-ref": item.ref };
}

function rememberFocus(target: EventTarget | null): void {
  focusedRef.value = (target as HTMLElement | null)?.closest<HTMLElement>(
    "[data-artifact-ref]",
  )?.dataset.artifactRef;
}

function handlePreviewToggle(event: ToggleEvent): void {
  const popover = event.target as HTMLElement;
  if (!open.value || !popover.id) return;
  const trigger = viewport.value?.querySelector<HTMLButtonElement>(
    `button[popovertarget="${CSS.escape(popover.id)}"]`,
  );
  const itemRef = trigger?.closest<HTMLElement>("[data-artifact-ref]")?.dataset.artifactRef;
  if (!trigger || !itemRef) return;
  if (event.newState === "open") {
    previewRef.value = itemRef;
    return;
  }
  requestAnimationFrame(() => {
    if (previewRef.value !== itemRef || popover.matches(":popover-open")) return;
    const active = document.activeElement;
    if (
      viewport.value?.closest(":popover-open") &&
      (active === document.body ||
        active === viewport.value ||
        active === trigger ||
        popover.contains(active))
    ) {
      trigger.focus();
      trigger.scrollIntoView({ block: "nearest" });
    }
    previewRef.value = undefined;
  });
}

function cancelPageRequest(): void {
  pageRequest.value?.abort();
  pageRequest.value = undefined;
}

function appendPage(page: ArtifactLibraryResponse): void {
  const present = new Set(artifacts.value.map((item) => item.ref));
  artifacts.value = [
    ...artifacts.value,
    ...page.artifacts.filter((item) => !present.has(item.ref)),
  ];
  nextCursor.value = page.nextCursor;
}

async function loadPage(after?: string, refresh = false): Promise<void> {
  if (pageRequest.value || saving.value || deferredPage.value) return;
  const request = new AbortController();
  pageRequest.value = request;
  pageError.value = "";
  try {
    const page = await getArtifacts(after, request.signal);
    if (request.signal.aborted || saving.value) return;
    if (after !== undefined) appendPage(page);
    else if (refresh) await replaceFirstPage(page, false);
    else {
      artifacts.value = page.artifacts;
      nextCursor.value = page.nextCursor;
    }
  } catch (cause) {
    if (request.signal.aborted || saving.value) return;
    if (after !== undefined && cause instanceof ArtifactCatalogChanged) {
      pageRequest.value = undefined;
      void loadPage(undefined, true);
      return;
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    if (after !== undefined || refresh) pageError.value = message;
    else error.value = message;
  } finally {
    if (pageRequest.value === request) pageRequest.value = undefined;
  }
}

watch(
  [viewport, pageEnd, nextCursor, open, saving, pageError, deferredPage],
  ([root, end, cursor, isOpen, isSaving, failure, deferred], _previous, onCleanup) => {
    if (!root || !end || cursor === undefined || !isOpen || isSaving || failure || deferred) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && nextCursor.value === cursor && open.value)
          void loadPage(cursor);
      },
      { root },
    );
    observer.observe(end);
    onCleanup(() => observer.disconnect());
  },
  { flush: "post" },
);

function handleToggle(event: Event): void {
  open.value = (event as ToggleEvent).newState === "open";
  if (!open.value) {
    cancelPageRequest();
    previewRef.value = undefined;
    return;
  }
  if (saving.value) return;
  artifacts.value = [];
  nextCursor.value = undefined;
  error.value = "";
  void loadPage();
}

function retryNextPage(): void {
  viewport.value?.focus({ preventScroll: true });
  void loadPage(nextCursor.value);
}

async function replaceFirstPage(page: ArtifactLibraryResponse, fromStar: boolean): Promise<void> {
  if (previewRef.value) {
    deferredPage.value = { page, fromStar };
    return;
  }
  const active = document.activeElement;
  const activeRow = focusedRef.value;
  artifacts.value = page.artifacts;
  nextCursor.value = page.nextCursor;
  pageError.value = "";
  await nextTick();
  if (open.value) {
    if (activeRow && active instanceof HTMLElement && active.isConnected) {
      active.focus();
      active.scrollIntoView({ block: "nearest" });
    } else {
      if (activeRow) viewport.value?.focus({ preventScroll: true });
      viewport.value?.scrollTo(0, 0);
    }
  }
  if (fromStar) saving.value = false;
}

watch(previewRef, (activePreview) => {
  if (activePreview || !deferredPage.value) return;
  const { page, fromStar } = deferredPage.value;
  deferredPage.value = undefined;
  void replaceFirstPage(page, fromStar);
});

async function toggleStar(item: ArtifactLibraryItem): Promise<void> {
  if (saving.value) return;
  saving.value = true;
  error.value = "";
  try {
    const page = await setArtifactStar(item.ref, !item.starred);
    cancelPageRequest();
    await replaceFirstPage(page, true);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
    saving.value = false;
  }
}

onMounted(() => document.addEventListener("beforetoggle", handlePreviewToggle, true));
onBeforeUnmount(() => {
  cancelPageRequest();
  document.removeEventListener("beforetoggle", handlePreviewToggle, true);
});
</script>

<template>
  <FullPopover
    :popover-id="props.popoverId"
    title="Artifacts"
    close-label="Close artifacts"
    role="dialog"
    aria-label="Artifacts"
    @toggle="handleToggle"
  >
    <div class="artifact-library">
      <p v-if="error" class="artifact-library__status artifact-library__error" role="alert">
        {{ error }}
      </p>
      <div
        ref="viewport"
        class="artifact-library__viewport"
        tabindex="0"
        role="region"
        aria-label="Artifact list"
        @focusin="rememberFocus($event.target)"
        @focusout="rememberFocus($event.relatedTarget)"
      >
        <Virtualizer
          v-if="artifacts.length"
          as="ul"
          item="li"
          class="artifact-library__list"
          role="list"
          aria-label="Artifacts"
          :data="artifacts"
          :item-props="rowAttributes"
          :keep-mounted="keptRows"
          :scroll-ref="viewport"
        >
          <template #default="{ item }">
            <ArtifactLibraryRow
              :key="item.ref"
              :item="item"
              :saving="saving"
              @star="toggleStar(item)"
            />
          </template>
        </Virtualizer>
        <div v-else-if="pageRequest" class="artifact-library__status">
          <LoadingIndicator label="Loading artifacts" />
        </div>
        <p v-else-if="open && !error" class="artifact-library__status">No artifacts yet.</p>
        <div v-if="nextCursor !== undefined" ref="pageEnd" class="artifact-library__page-end">
          <div v-if="pageError" class="artifact-library__status">
            <p class="artifact-library__error" role="alert">{{ pageError }}</p>
            <button class="chrome-button" type="button" @click="retryNextPage">Retry</button>
          </div>
          <div v-else-if="pageRequest" class="artifact-library__status">
            <LoadingIndicator label="Loading more artifacts" />
          </div>
        </div>
      </div>
    </div>
  </FullPopover>
</template>

<style scoped>
.artifact-library {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--color-bg-app);
}

.artifact-library__viewport {
  flex: 1;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  overflow-anchor: none;
}

.artifact-library__list {
  max-width: 60rem;
  margin: 0 auto;
  padding: 0;
  list-style: none;
}

.artifact-library__page-end {
  min-height: 1px;
}

.artifact-library__status {
  margin: 0;
  padding: 2rem 1rem;
  color: var(--color-text-muted);
  text-align: center;
}

.artifact-library__error {
  color: var(--color-error);
}
</style>
