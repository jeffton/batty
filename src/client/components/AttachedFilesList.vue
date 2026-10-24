<script setup lang="ts">
import TranscriptImage from "./TranscriptImage.vue";
import type { SentFileDescriptor } from "@/shared/types";

const props = withDefaults(
  defineProps<{
    files: SentFileDescriptor[];
    preview?: boolean;
    compact?: boolean;
  }>(),
  {
    preview: true,
    compact: false,
  },
);

function formatFileSize(size: number): string {
  if (!Number.isFinite(size) || size < 1024) {
    return `${Math.max(0, Math.floor(size || 0))} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}
</script>

<template>
  <div :class="['attached-files', props.compact ? 'attached-files--compact' : '']">
    <article v-for="file in props.files" :key="file.id" class="attached-files__card">
      <TranscriptImage
        v-if="props.preview && file.kind === 'image' && file.previewUrl"
        :src="`${file.previewUrl}${file.previewUrl.includes('?') ? '&' : '?'}preview=1`"
        :original-url="file.mimeType === 'image/svg+xml' ? file.downloadUrl : file.previewUrl"
        :alt="file.name"
      />
      <video
        v-else-if="props.preview && file.kind === 'video' && file.previewUrl"
        :src="file.previewUrl"
        class="attached-files__preview"
        preload="metadata"
        muted
        playsinline
      />

      <div class="attached-files__meta">
        <strong class="attached-files__name">{{ file.name }}</strong>
        <span class="attached-files__facts"
          >{{ file.mimeType }} · {{ formatFileSize(file.size) }}</span
        >
      </div>

      <a
        :href="file.downloadUrl"
        :download="file.name"
        target="_blank"
        rel="noopener noreferrer"
        class="attached-files__download"
      >
        Download
      </a>
    </article>
  </div>
</template>

<style scoped>
.attached-files {
  display: grid;
  gap: 0.6rem;
}

.attached-files--compact {
  gap: 0.45rem;
}

.attached-files__card {
  display: grid;
  gap: 0.5rem;
  padding: 0.65rem;
  border: 1px solid var(--color-border);
  border-radius: 0.65rem;
  background: var(--color-bg-panel);
}

.attached-files__preview {
  display: block;
  width: 100%;
  max-width: min(100%, 28rem);
  max-height: 16rem;
  object-fit: contain;
  border-radius: 0.45rem;
  background: var(--color-bg-elevated-soft);
}

.attached-files__meta {
  display: grid;
  gap: 0.15rem;
  min-width: 0;
}

.attached-files__name {
  overflow-wrap: anywhere;
}

.attached-files__facts {
  color: var(--color-text-muted);
  font-size: 0.9rem;
  overflow-wrap: anywhere;
}

.attached-files__download {
  justify-self: start;
  color: var(--color-accent);
  text-decoration: none;
  font-weight: 600;
}

@media (hover: hover) {
  .attached-files__download:hover {
    text-decoration: underline;
  }
}
</style>
