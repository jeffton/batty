<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { Search } from "@lucide/vue";
import { Virtualizer, type VirtualizerHandle } from "virtua/vue";
import { searchWorkspaceFiles } from "@/client/lib/api";

const props = defineProps<{ workspaceId?: string; active: boolean; idPrefix: string }>();
const emit = defineEmits<{ select: [path: string] }>();
const input = ref<HTMLInputElement>();
const list = ref<VirtualizerHandle>();
const query = ref("");
const matches = ref<string[]>([]);
const activeIndex = ref(0);
const loading = ref(false);
const error = ref("");
const listId = computed(() => `${props.idPrefix}-results`);
const activeId = computed(() =>
  matches.value[activeIndex.value] ? `${listId.value}-${activeIndex.value}` : undefined,
);
let controller: AbortController | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;

function cancel(): void {
  clearTimeout(timer);
  controller?.abort();
  controller = undefined;
}

watch([query, () => props.active, () => props.workspaceId], () => {
  cancel();
  matches.value = [];
  activeIndex.value = 0;
  error.value = "";
  loading.value = false;
  if (!props.active) {
    query.value = "";
    return;
  }
  if (!query.value || !props.workspaceId) return;
  loading.value = true;
  const request = new AbortController();
  controller = request;
  const name = query.value;
  const workspaceId = props.workspaceId;
  // Debounce typing; a changed query also cancels the server's filesystem walk.
  timer = setTimeout(async () => {
    try {
      await searchWorkspaceFiles(workspaceId, name, request.signal, (paths) => {
        if (controller === request) matches.value.push(...paths);
      });
    } catch (cause) {
      if (controller === request && !request.signal.aborted)
        error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (controller === request) loading.value = false;
    }
  }, 150);
});

function focus(): void {
  input.value?.focus();
  input.value?.select();
}

function choose(path: string): void {
  query.value = "";
  emit("select", path);
}

async function move(direction: number): Promise<void> {
  if (!matches.value.length) return;
  activeIndex.value = (activeIndex.value + direction + matches.value.length) % matches.value.length;
  await nextTick();
  list.value?.scrollToIndex(activeIndex.value, { align: "nearest" });
}

function keydown(event: KeyboardEvent): void {
  if (!query.value) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    query.value = "";
    focus();
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    void move(event.key === "ArrowDown" ? 1 : -1);
  } else if (event.key === "Enter") {
    event.preventDefault();
    const path = matches.value[activeIndex.value];
    if (path) choose(path);
  }
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
function parent(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
}

onBeforeUnmount(cancel);
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
        type="text"
        role="combobox"
        aria-label="Find file by name"
        autocomplete="off"
        spellcheck="false"
        placeholder="Find file…"
        :aria-expanded="!!query"
        :aria-controls="query ? listId : undefined"
        :aria-activedescendant="activeId"
      />
    </label>
    <div v-show="!query" class="file-search__tree"><slot /></div>
    <template v-if="query">
      <div v-if="loading" class="file-search__status" role="status">Searching…</div>
      <div v-if="error" class="file-search__status file-search__error" role="alert">
        {{ error }}
      </div>
      <div v-else-if="!loading && !matches.length" class="file-search__status" role="status">
        No files found.
      </div>
      <div :id="listId" class="file-search__results" role="listbox" aria-label="Matching files">
        <Virtualizer ref="list" :data="matches" :keep-mounted="matches.length ? [activeIndex] : []">
          <template #default="{ item: path, index }">
            <button
              :id="`${listId}-${index}`"
              :key="path"
              type="button"
              role="option"
              tabindex="-1"
              :aria-selected="index === activeIndex"
              class="file-search__result"
              @pointermove="activeIndex = index"
              @click="choose(path)"
            >
              <strong>{{ basename(path) }}</strong>
              <span>{{ parent(path) }}</span>
            </button>
          </template>
        </Virtualizer>
      </div>
    </template>
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
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.file-search__result {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: auto;
  gap: 0.15rem;
  padding: 0.5rem 0.75rem;
  border: 0;
  border-bottom: 1px solid var(--color-border-soft);
  background: transparent;
  color: var(--color-text);
  font-size: 0.8rem;
  font-weight: 400;
  text-align: left;
  overflow-wrap: anywhere;
}
.file-search__result[aria-selected="true"] {
  background: var(--color-bg-selection);
}
.file-search__result:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}
.file-search__result span {
  color: var(--color-text-subtle);
  font-family: var(--font-family-mono);
  font-size: 0.7rem;
}
.file-search__status {
  padding: 0.5rem 0.75rem;
  color: var(--color-text-subtle);
  font-size: 0.8rem;
}
.file-search__error {
  color: var(--color-error);
}
</style>
