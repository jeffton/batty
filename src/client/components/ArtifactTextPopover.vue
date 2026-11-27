<script setup lang="ts">
import { Download } from "@lucide/vue";
import type { CodeView } from "@pierre/diffs";
import { onBeforeUnmount, ref } from "vue";
import { mountCodeView } from "@/client/lib/code-view";
import type { SentFileDescriptor } from "@/shared/types";
import AttachedFileDownload from "./AttachedFileDownload.vue";
import FullPopover from "./FullPopover.vue";
import LoadingIndicator from "./LoadingIndicator.vue";

const props = defineProps<{ popoverId: string; file: SentFileDescriptor; previewUrl: string }>();
const root = ref<HTMLElement>();
const loading = ref(false);
const empty = ref(false);
const truncated = ref(false);
const error = ref("");
let request: AbortController | undefined;
let view: CodeView | undefined;

function cleanUp(): void {
  request?.abort();
  view?.cleanUp();
  view = undefined;
}

async function loadText(signal: AbortSignal) {
  const response = await fetch(props.previewUrl, { credentials: "include", signal });
  if (!response.ok) {
    const status = `Preview failed (HTTP ${response.status}).`;
    if (response.headers.get("content-type")?.startsWith("application/json")) {
      const { error } = (await response.json()) as { error: string };
      throw new Error(`${status} ${error}`);
    }
    throw new Error(status);
  }
  return {
    contents: await response.text(),
    truncated: response.headers.get("X-Batty-Preview-Truncated") === "1",
  };
}

async function open(): Promise<void> {
  request = new AbortController();
  const { signal } = request;
  loading.value = true;
  empty.value = false;
  truncated.value = false;
  error.value = "";
  try {
    const preview = await loadText(signal);
    if (signal.aborted) return;
    const { contents } = preview;
    truncated.value = preview.truncated;
    if (!contents.length) {
      empty.value = true;
      return;
    }
    const { CodeView } = await import("@pierre/diffs");
    if (signal.aborted) return;
    view = mountCodeView(CodeView, root.value!);
    view.setItems([{ id: props.file.id, type: "file", file: { name: props.file.name, contents } }]);
  } catch (cause) {
    if (!signal.aborted) error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (!signal.aborted) loading.value = false;
  }
}

function handleToggle(event: Event): void {
  if ((event as ToggleEvent).newState === "open") void open();
  else cleanUp();
}

onBeforeUnmount(cleanUp);
</script>

<template>
  <FullPopover
    :popover-id="props.popoverId"
    :title="props.file.name"
    close-label="Close file preview"
    role="dialog"
    :aria-label="props.file.name"
    @toggle="handleToggle"
  >
    <template #header-actions>
      <AttachedFileDownload
        :file="props.file"
        class="chrome-button chrome-button--icon"
        aria-label="Download file"
        title="Download file"
      >
        <Download :size="18" aria-hidden="true" />
      </AttachedFileDownload>
    </template>
    <div class="artifact-text">
      <LoadingIndicator v-if="loading" class="artifact-text__status" label="Loading file" />
      <div v-else-if="error" class="artifact-text__status artifact-text__error" role="alert">
        {{ error }}
      </div>
      <div v-else-if="empty" class="artifact-text__status">Empty file.</div>
      <div v-else-if="truncated" class="artifact-text__status artifact-text__notice" role="status">
        Preview truncated. Download the full file.
      </div>
      <div
        ref="root"
        class="artifact-text__viewer"
        role="region"
        aria-label="File preview"
        tabindex="0"
      />
    </div>
  </FullPopover>
</template>

<style scoped>
.artifact-text {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.artifact-text__viewer {
  flex: 1;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
}

.artifact-text__viewer:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}

.artifact-text__status {
  padding: 1rem;
  font-size: 0.85rem;
  color: var(--color-text-subtle);
  overflow-wrap: anywhere;
}

.artifact-text__notice {
  padding-block: 0.6rem;
  border-bottom: 1px solid var(--color-border-soft);
}

.artifact-text__error {
  color: var(--color-error);
}
</style>
