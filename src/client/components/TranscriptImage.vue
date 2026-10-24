<script setup lang="ts">
import { ref, useId, watch } from "vue";
import ImagePopover from "./ImagePopover.vue";
const popoverId = useId();
const failed = ref(false);
const props = defineProps<{
  src: string;
  originalUrl?: string;
  alt: string;
  width?: number;
  height?: number;
}>();
watch(
  () => props.src,
  () => {
    failed.value = false;
  },
);
</script>

<template>
  <button
    type="button"
    class="transcript-image"
    :popovertarget="popoverId"
    :aria-label="`Open original: ${props.alt}`"
    :style="
      props.width && props.height ? { aspectRatio: `${props.width} / ${props.height}` } : undefined
    "
  >
    <span v-if="failed" role="alert" class="transcript-image__error"
      >Preview unavailable · Open original</span
    >
    <img
      v-else
      @error="failed = true"
      :src="props.src"
      :alt="props.alt"
      :width="props.width"
      :height="props.height"
      loading="lazy"
      decoding="async"
      fetchpriority="low"
    />
  </button>
  <ImagePopover :popover-id="popoverId" :src="props.originalUrl ?? props.src" :alt="props.alt" />
</template>

<style scoped>
.transcript-image {
  display: block;
  padding: 0;
  border: 0;
  cursor: zoom-in;
  width: min(100%, 32rem);
  height: auto;
  max-height: 24rem;
  aspect-ratio: 4 / 3;
  overflow: hidden;
  border-radius: 0.45rem;
  background: var(--color-bg-elevated-soft);
}

.transcript-image__error {
  display: grid;
  height: 100%;
  place-items: center;
  color: var(--color-text-muted);
  padding: 1rem;
}

.transcript-image img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.transcript-image:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}
</style>
