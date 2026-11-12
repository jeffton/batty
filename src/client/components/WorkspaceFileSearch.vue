<script setup lang="ts">
import type { FileTree } from "@pierre/trees";
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import { Search } from "@lucide/vue";
import { searchWorkspaceFiles } from "@/client/lib/api";

const props = defineProps<{ workspaceId?: string; active: boolean; idPrefix: string }>();
const emit = defineEmits<{ select: [path: string] }>();
const input = ref<HTMLInputElement>();
const filteredRoot = ref<HTMLElement>();
const query = ref("");
const matchCount = ref(0);
const loading = ref(false);
const error = ref("");
let tree: FileTree | undefined;
let controller: AbortController | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let frame: number | undefined;
let pending: string[] = [];

function flushMatches(): void {
  if (frame !== undefined) cancelAnimationFrame(frame);
  frame = undefined;
  if (!pending.length) return;
  const paths = pending;
  pending = [];
  tree!.batch(paths.map((path) => ({ type: "add", path })));
  matchCount.value += paths.length;
}

function cancel(): void {
  clearTimeout(timer);
  controller?.abort();
  controller = undefined;
  if (frame !== undefined) cancelAnimationFrame(frame);
  frame = undefined;
  pending = [];
}

watch([query, () => props.active, () => props.workspaceId], () => {
  cancel();
  tree?.resetPaths([]);
  matchCount.value = 0;
  error.value = "";
  loading.value = false;
  if (!props.active) {
    query.value = "";
    tree?.cleanUp();
    tree = undefined;
    return;
  }
  if (!query.value || !props.workspaceId) return;
  loading.value = true;
  const request = new AbortController();
  controller = request;
  const name = query.value;
  const workspaceId = props.workspaceId;
  timer = setTimeout(async () => {
    try {
      const { FileTree } = await import("@pierre/trees");
      await nextTick();
      if (controller !== request) return;
      if (!tree) {
        // The server supplies only filename-matching leaves. Pierre builds their
        // ancestors without applying its separate, full-path search semantics.
        tree = new FileTree({
          paths: [],
          initialExpansion: "open",
          flattenEmptyDirectories: false,
          icons: "standard",
          onSelectionChange: (paths) => {
            const path = paths[0];
            if (path && !tree!.getItem(path)!.isDirectory()) emit("select", path);
          },
        });
        tree.render({ fileTreeContainer: filteredRoot.value! });
      }
      await searchWorkspaceFiles(workspaceId, name, request.signal, (paths) => {
        if (controller !== request) return;
        pending.push(...paths);
        if (frame === undefined) frame = requestAnimationFrame(flushMatches);
      });
    } catch (cause) {
      if (controller === request && !request.signal.aborted)
        error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (controller === request) {
        flushMatches();
        loading.value = false;
      }
    }
  }, 150);
});

function focus(): void {
  input.value?.focus();
  input.value?.select();
}

function keydown(event: KeyboardEvent): void {
  if (!query.value) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    query.value = "";
    focus();
  } else if (event.target === input.value && event.key === "ArrowDown") {
    // Enter the native tree at its roving tab stop; subsequent arrows/Enter
    // belong entirely to Pierre's tree keyboard handling.
    const row = filteredRoot.value?.shadowRoot?.querySelector<HTMLElement>(
      '[role="treeitem"][tabindex="0"]',
    );
    if (row) {
      event.preventDefault();
      row.focus();
    }
  }
}

onBeforeUnmount(() => {
  cancel();
  tree?.cleanUp();
});
defineExpose({ focus });
</script>

<template>
  <div class="file-search" @keydown="keydown">
    <label class="file-search__field">
      <Search :size="15" aria-hidden="true" />
      <input
        ref="input"
        v-model="query"
        :disabled="!props.active"
        type="search"
        aria-label="Find file by name"
        autocomplete="off"
        spellcheck="false"
        placeholder="Find file…"
        :aria-controls="query ? `${props.idPrefix}-filtered-tree` : undefined"
      />
    </label>
    <div v-show="!query" class="file-search__tree"><slot /></div>
    <div v-if="query && loading" class="file-search__status" role="status" aria-label="Searching">
      <span class="spinner file-search__spinner" aria-hidden="true" />
    </div>
    <div v-if="query && error" class="file-search__status file-search__error" role="alert">
      {{ error }}
    </div>
    <div v-else-if="query && !loading && !matchCount" class="file-search__status" role="status">
      No files found.
    </div>
    <div
      v-show="query"
      :id="`${props.idPrefix}-filtered-tree`"
      ref="filteredRoot"
      class="file-search__results"
    />
  </div>
</template>

<style scoped>
.file-search,
.file-search__tree {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.file-search__field {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  gap: 0.5rem;
  margin: 0.65rem;
  padding: 0.45rem 0.6rem;
  border: 1px solid var(--color-border-soft);
  border-radius: var(--chrome-control-radius);
  background: var(--color-bg-panel);
  color: var(--color-text-subtle);
}
.file-search__field:focus-within {
  border-color: var(--color-accent);
}
.file-search__field input {
  width: 100%;
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--color-text);
  font-size: 0.85rem;
}
.file-search__results {
  display: flex;
  flex: 1;
  min-height: 0;
  width: 100%;
  --trees-font-family-override: var(--font-family-mono);
  --trees-font-size-override: 12px;
  --trees-fg-override: var(--color-text);
  --trees-fg-muted-override: var(--color-text-subtle);
  --trees-bg-override: var(--color-bg-app);
  --trees-bg-muted-override: var(--color-chrome-hover);
  --trees-selected-bg-override: var(--color-bg-selection);
  --trees-selected-fg-override: var(--color-text-strong);
  --trees-accent-override: var(--color-accent);
  --trees-border-color-override: var(--color-border-soft);
}
.file-search__status {
  padding: 0.5rem 0.75rem;
  color: var(--color-text-subtle);
  font-size: 0.8rem;
}
.file-search__spinner {
  display: block;
  width: 1rem;
  height: 1rem;
  border-width: 2px;
}
.file-search__error {
  color: var(--color-error);
}
</style>
