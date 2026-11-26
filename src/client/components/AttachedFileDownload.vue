<script setup lang="ts">
import { ref } from "vue";
import type { SentFileDescriptor } from "@/shared/types";

defineOptions({ inheritAttrs: false });

const props = defineProps<{ file: SentFileDescriptor }>();
const error = ref("");
const downloading = ref(false);

async function download(event: MouseEvent): Promise<void> {
  event.preventDefault();
  if (downloading.value) return;
  downloading.value = true;
  error.value = "";
  try {
    const response = await fetch(props.file.downloadUrl, { credentials: "include" });
    if (!response.ok) {
      error.value = `Download failed (HTTP ${response.status}).`;
      return;
    }
    downloadBlob(await response.blob(), props.file.name);
  } catch (cause) {
    error.value = `Download failed: ${cause instanceof Error ? cause.message : cause}`;
  } finally {
    downloading.value = false;
  }
}

function downloadBlob(blob: Blob, name: string): void {
  // Blob downloads keep iOS standalone apps out of the native URL preview.
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = name;
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
}
</script>

<template>
  <a
    v-bind="$attrs"
    :href="props.file.downloadUrl"
    :download="props.file.name"
    :aria-disabled="downloading"
    @click="download"
  >
    <slot>Download</slot>
  </a>
  <span v-if="error" role="alert" class="attached-file-download__error">{{ error }}</span>
</template>

<style scoped>
.attached-file-download__error {
  color: var(--color-error);
}
</style>
