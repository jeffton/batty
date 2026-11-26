<script setup lang="ts">
import { Download, File, Globe, Image, Star } from "@lucide/vue";
import { computed, useId } from "vue";
import type { ArtifactLibraryItem } from "@/shared/artifact-library";
import { imageViewerUrl } from "@/client/lib/file-preview";
import AttachedFileDownload from "./AttachedFileDownload.vue";
import ImagePopover from "./ImagePopover.vue";
import SitePopover from "./SitePopover.vue";

const props = defineProps<{ item: ArtifactLibraryItem; saving: boolean }>();
const emit = defineEmits<{ star: [button: HTMLButtonElement] }>();
const previewId = useId();
const imageUrl = computed(() => {
  const item = props.item;
  if (item.kind === "file" && item.file.kind === "image" && item.file.previewUrl)
    return imageViewerUrl(item.file, item.file.previewUrl);
});
const metadata = computed(() => {
  const kind =
    props.item.kind === "site" ? "Site" : props.item.source === "upload" ? "Upload" : "File";
  const date = new Date(props.item.createdAt).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return `${kind} · ${date}`;
});
</script>

<template>
  <li class="artifact-row">
    <button
      v-if="props.item.kind === 'site' || imageUrl"
      type="button"
      class="artifact-row__action"
      :popovertarget="previewId"
    >
      <component :is="props.item.kind === 'site' ? Globe : Image" :size="19" aria-hidden="true" />
      <span>
        <strong>{{ props.item.title }}</strong>
        <small>{{ metadata }}</small>
      </span>
    </button>
    <AttachedFileDownload
      v-else-if="props.item.kind === 'file'"
      :file="props.item.file"
      class="artifact-row__action"
      :aria-label="`Download ${props.item.title}`"
    >
      <File :size="19" aria-hidden="true" />
      <span>
        <strong>{{ props.item.title }}</strong>
        <small>{{ metadata }}</small>
      </span>
      <Download :size="16" class="artifact-row__download" aria-hidden="true" />
    </AttachedFileDownload>
    <button
      type="button"
      class="chrome-button chrome-button--icon artifact-row__star"
      :aria-label="`Star ${props.item.title}`"
      :aria-pressed="props.item.starred"
      :aria-disabled="props.saving"
      @click="emit('star', $event.currentTarget as HTMLButtonElement)"
    >
      <Star :size="17" aria-hidden="true" />
    </button>
    <SitePopover
      v-if="props.item.kind === 'site'"
      :popover-id="previewId"
      :site="props.item.site"
    />
    <ImagePopover
      v-else-if="props.item.kind === 'file' && imageUrl"
      :popover-id="previewId"
      :src="imageUrl"
      :alt="props.item.title"
    >
      <template #header-actions>
        <AttachedFileDownload
          :file="props.item.file"
          class="chrome-button chrome-button--icon"
          aria-label="Download image"
          title="Download image"
        >
          <Download :size="18" aria-hidden="true" />
        </AttachedFileDownload>
      </template>
    </ImagePopover>
  </li>
</template>

<style scoped>
.artifact-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-rows: auto auto;
  align-items: center;
  gap: 0 0.35rem;
  padding-inline-end: 0.7rem;
  border-bottom: 1px solid var(--color-border-soft);
}

.artifact-row :deep(.artifact-row__action) {
  display: flex;
  grid-area: 1 / 1;
  align-items: center;
  gap: 0.7rem;
  min-width: 0;
  height: auto;
  padding: 0.75rem 1rem;
  border: 0;
  background: transparent;
  color: var(--color-text);
  font: inherit;
  text-align: left;
  text-decoration: none;
  cursor: pointer;
}

.artifact-row :deep(.artifact-row__action:hover) {
  background: var(--color-chrome-hover);
}

.artifact-row :deep(.artifact-row__action:focus-visible) {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}

.artifact-row__action svg,
.artifact-row__download {
  flex: none;
  color: var(--color-text-muted);
}

.artifact-row__download {
  margin-inline-start: auto;
}

.artifact-row strong {
  overflow-wrap: anywhere;
}

.artifact-row small {
  display: block;
  color: var(--color-text-muted);
}

.artifact-row__star {
  grid-area: 1 / 2;
}

.artifact-row__star[aria-pressed="true"] {
  color: var(--color-accent);
}

.artifact-row__star[aria-pressed="true"] svg {
  fill: currentColor;
}

.artifact-row > :deep([role="alert"]) {
  grid-column: 1 / -1;
  padding: 0 1rem 0.75rem;
}
</style>
