<script setup lang="ts">
import type { FileTree } from "@pierre/trees";
import type { CodeView } from "@pierre/diffs";
import { computed, nextTick, onBeforeUnmount, ref } from "vue";
import { FolderTree, Search, GitBranch } from "@lucide/vue";
import WorkspaceFileSearch from "./WorkspaceFileSearch.vue";
import FullPopover from "./FullPopover.vue";
import { getWorkspaceFiles, getWorkspaceGit } from "@/client/lib/api";
import type { WorkspaceInfo } from "@/shared/types";

const props = defineProps<{ popoverId: string; workspace?: WorkspaceInfo }>();
const fileSearch = ref<InstanceType<typeof WorkspaceFileSearch>>();
const searchActive = ref(false);
let opened = false;
const treeRoot = ref<HTMLElement>();
const codeRoot = ref<HTMLElement>();
const selectedPath = ref("");
const branch = ref<string | null>(null);
const branchError = ref("");
const loadingFile = ref(false);
const loadingDirectories = ref(0);
const fileMessage = ref("");
const fileError = ref("");
const directoryErrors = ref<Record<string, string>>({});
const reading = ref(false);
const rootEmpty = ref(false);
const subtitle = computed(() => selectedPath.value || props.workspace?.path);
let tree: FileTree | undefined;
let code: CodeView | undefined;
let unsubscribe: (() => void) | undefined;
let generation = 0;
let fileGeneration = 0;
const directories = new Map<string, "unloaded" | "loading" | "loaded" | "error">();

function cleanUp(): void {
  searchActive.value = false;
  generation++;
  fileGeneration++;
  unsubscribe?.();
  tree?.cleanUp();
  code?.cleanUp();
  tree = undefined;
  code = undefined;
  directories.clear();
}

async function loadDirectory(path: string, currentGeneration = generation): Promise<void> {
  if (!props.workspace || directories.get(path) === "loading" || directories.get(path) === "loaded")
    return;
  directories.set(path, "loading");
  loadingDirectories.value++;
  delete directoryErrors.value[path];
  try {
    const result = await getWorkspaceFiles(props.workspace.id, path);
    if (currentGeneration !== generation) return;
    if (result.kind !== "directory") throw new Error("Path is not a directory");
    directories.set(path, "loaded");
    if (!path) rootEmpty.value = result.entries.length === 0;
    for (const entry of result.entries) {
      if (entry.kind === "directory") directories.set(entry.path, "unloaded");
    }
    tree!.batch(
      result.entries.map((entry) => ({
        type: "add",
        path: entry.kind === "directory" ? `${entry.path}/` : entry.path,
      })),
    );
  } catch (cause) {
    if (currentGeneration !== generation) return;
    directories.set(path, "error");
    directoryErrors.value[path] = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (currentGeneration === generation) loadingDirectories.value--;
  }
}

function loadExpandedDirectories(): void {
  for (const [path, state] of directories) {
    if (state !== "unloaded") continue;
    const item = tree?.getItem(path);
    if (item?.isDirectory() && item.isExpanded()) void loadDirectory(path);
  }
}

async function selectFile(path: string): Promise<void> {
  if (!props.workspace || tree?.getItem(path)?.isDirectory()) return;
  const currentGeneration = generation;
  const request = ++fileGeneration;
  selectedPath.value = path;
  reading.value = true;
  loadingFile.value = true;
  fileMessage.value = "";
  fileError.value = "";
  code?.setItems([]);
  try {
    const result = await getWorkspaceFiles(props.workspace.id, path);
    if (currentGeneration !== generation || request !== fileGeneration) return;
    if (result.kind === "text") {
      if (!result.contents) fileMessage.value = "Empty file.";
      else {
        code!.setItems([
          { id: path, type: "file", file: { name: path, contents: result.contents } },
        ]);
      }
    } else if (result.kind === "binary") fileMessage.value = "Binary file — no text preview.";
    else if (result.kind === "unsupported") fileMessage.value = "Not a regular file — no preview.";
    else throw new Error("Path is a directory");
  } catch (cause) {
    if (currentGeneration === generation && request === fileGeneration)
      fileError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (currentGeneration === generation && request === fileGeneration) loadingFile.value = false;
  }
}

async function loadBranch(currentGeneration: number): Promise<void> {
  if (!props.workspace) return;
  try {
    const result = await getWorkspaceGit(props.workspace.id);
    if (currentGeneration === generation) branch.value = result.branch;
  } catch (cause) {
    if (currentGeneration === generation)
      branchError.value = cause instanceof Error ? cause.message : String(cause);
  }
}

async function open(): Promise<void> {
  cleanUp();
  const currentGeneration = generation;
  branch.value = null;
  branchError.value = "";
  void loadBranch(currentGeneration);
  selectedPath.value = "";
  loadingFile.value = false;
  loadingDirectories.value = 0;
  fileMessage.value = "";
  fileError.value = "";
  directoryErrors.value = {};
  reading.value = false;
  rootEmpty.value = false;
  try {
    const [trees, diffs] = await Promise.all([import("@pierre/trees"), import("@pierre/diffs")]);
    await nextTick();
    if (currentGeneration !== generation || !treeRoot.value || !codeRoot.value) return;
    tree = new trees.FileTree({
      paths: [],
      initialExpansion: "closed",
      flattenEmptyDirectories: false,
      icons: "standard",
      onSelectionChange: (paths) => {
        if (paths[0]) void selectFile(paths[0]);
      },
    });
    tree.render({ fileTreeContainer: treeRoot.value });
    unsubscribe = tree.subscribe(loadExpandedDirectories);
    code = new diffs.CodeView({
      theme: { dark: "pierre-dark", light: "pierre-light" },
      themeType: "system",
      overflow: "wrap",
      disableFileHeader: true,
      layout: { paddingTop: 12, paddingBottom: 12, gap: 0 },
      unsafeCSS: `
        :host { --diffs-font-family: var(--font-family-mono); }
        [data-line], [data-line] span { font-weight: 400; }
      `,
    });
    code.setup(codeRoot.value);
    searchActive.value = true;
    await loadDirectory("", currentGeneration);
  } catch (cause) {
    if (currentGeneration === generation)
      directoryErrors.value[""] = cause instanceof Error ? cause.message : String(cause);
  }
}

async function focusSearch(): Promise<void> {
  reading.value = false;
  await nextTick();
  fileSearch.value?.focus();
}

async function selectSearchFile(path: string): Promise<void> {
  const currentGeneration = generation;
  await selectFile(path);
  await nextTick();
  if (currentGeneration === generation && window.matchMedia("(max-width: 600px)").matches)
    codeRoot.value?.focus({ preventScroll: true });
}

function shortcut(event: KeyboardEvent): void {
  if (
    !opened ||
    event.defaultPrevented ||
    event.key.toLowerCase() !== "p" ||
    !(event.ctrlKey || event.metaKey) ||
    event.altKey ||
    event.shiftKey
  )
    return;
  const element = document.getElementById(props.popoverId)!;
  if (!element.matches(":popover-open")) return;
  event.preventDefault();
  void focusSearch();
}

function handleToggle(event: Event): void {
  opened = (event as ToggleEvent).newState === "open";
  if (opened) {
    document.addEventListener("keydown", shortcut);
    void open();
  } else {
    document.removeEventListener("keydown", shortcut);
    cleanUp();
  }
}

onBeforeUnmount(() => {
  document.removeEventListener("keydown", shortcut);
  cleanUp();
});
</script>

<template>
  <FullPopover
    class="workspace-code-popover"
    role="dialog"
    :aria-label="`Code in ${props.workspace?.label ?? 'workspace'}`"
    :popover-id="props.popoverId"
    :title="props.workspace?.label ?? 'Code'"
    :subtitle="subtitle"
    close-label="Close code browser"
    @toggle="handleToggle"
  >
    <template v-if="branch || branchError" #header-content>
      <div class="workspace-code__git">
        <span v-if="branch" class="workspace-code__branch"
          ><GitBranch :size="14" aria-hidden="true" />{{ branch }}</span
        >
        <span v-if="branchError" class="workspace-code__branch-error" role="alert">{{
          branchError
        }}</span>
      </div>
    </template>
    <template #header-actions>
      <button
        type="button"
        class="chrome-button chrome-button--icon"
        aria-label="Find file"
        title="Find file (⌘/Ctrl+P)"
        @click="focusSearch"
      >
        <Search :size="16" />
      </button>
      <button
        class="workspace-code__files chrome-button"
        type="button"
        :aria-expanded="!reading"
        @click="reading = !reading"
      >
        <FolderTree :size="16" /> Files
      </button>
    </template>
    <div class="workspace-code" :class="{ 'workspace-code--reading': reading }">
      <aside class="workspace-code__sidebar" aria-label="Workspace files">
        <WorkspaceFileSearch
          ref="fileSearch"
          :workspace-id="props.workspace?.id"
          :active="searchActive"
          :id-prefix="props.popoverId"
          @select="selectSearchFile"
        >
          <div v-if="loadingDirectories" class="workspace-code__status" role="status">
            Loading files…
          </div>
          <div
            v-for="(message, path) in directoryErrors"
            :key="path"
            class="workspace-code__error"
            role="alert"
          >
            <div>{{ path || "Workspace" }}: {{ message }}</div>
            <button
              type="button"
              class="chrome-button"
              @click="tree ? loadDirectory(String(path)) : open()"
            >
              Retry
            </button>
          </div>
          <div ref="treeRoot" class="workspace-code__tree" />
          <div v-if="!loadingDirectories && rootEmpty" class="workspace-code__status">
            Empty directory.
          </div>
        </WorkspaceFileSearch>
      </aside>
      <section class="workspace-code__content" aria-label="File preview">
        <div v-if="loadingFile" class="workspace-code__status" role="status">Loading file…</div>
        <div v-else-if="fileError" class="workspace-code__error" role="alert">{{ fileError }}</div>
        <div v-else-if="fileMessage" class="workspace-code__status">{{ fileMessage }}</div>
        <div v-else-if="!selectedPath" class="workspace-code__status">Select a file.</div>
        <div ref="codeRoot" class="workspace-code__viewer" />
      </section>
    </div>
  </FullPopover>
</template>

<style scoped>
.workspace-code__git {
  min-width: 0;
  padding: 0 1rem 0.65rem;
  overflow-wrap: anywhere;
}
.workspace-code__branch {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  min-width: 0;
  color: var(--color-text-subtle);
  font-size: 0.78rem;
}
.workspace-code__branch svg {
  flex-shrink: 0;
}
.workspace-code__branch-error {
  color: var(--color-error);
  font-size: 0.78rem;
}
.workspace-code {
  display: grid;
  grid-template-columns: minmax(12rem, 24%) minmax(0, 1fr);
  height: 100%;
  min-height: 0;
}
.workspace-code__sidebar {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--color-border-soft);
  background: var(--color-bg-app);
  overflow: auto;
}
.workspace-code__tree {
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
.workspace-code__content {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--color-bg-panel);
}
.workspace-code__viewer {
  flex: 1;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
}
.workspace-code__status,
.workspace-code__error {
  padding: 1rem;
  font-size: 0.85rem;
  color: var(--color-text-subtle);
  overflow-wrap: anywhere;
}
.workspace-code__error {
  color: var(--color-error);
}
.workspace-code__files {
  display: none;
}
@media (max-width: 600px) {
  .workspace-code {
    grid-template-columns: minmax(0, 1fr);
  }
  .workspace-code__content,
  .workspace-code--reading .workspace-code__sidebar {
    display: none;
  }
  .workspace-code--reading .workspace-code__content {
    display: flex;
  }
  .workspace-code__files {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }
  .workspace-code__sidebar {
    border-right: 0;
  }
}
</style>
