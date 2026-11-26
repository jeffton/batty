<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import type { ArtifactLibraryItem } from "@/shared/artifact-library";
import { getArtifacts, setArtifactStar } from "@/client/lib/artifact-library";
import FullPopover from "./FullPopover.vue";
import ArtifactLibraryRow from "./ArtifactLibraryRow.vue";
import LoadingIndicator from "./LoadingIndicator.vue";

const props = defineProps<{ popoverId: string }>();
const artifacts = ref<ArtifactLibraryItem[]>([]);
const loading = ref(false);
const saving = ref(false);
const error = ref("");
const sorted = computed(() =>
  artifacts.value.toSorted(
    (a, b) =>
      Number(b.starred) - Number(a.starred) || Date.parse(b.createdAt) - Date.parse(a.createdAt),
  ),
);

async function loadArtifacts(): Promise<void> {
  if (loading.value || saving.value) return;
  loading.value = true;
  error.value = "";
  try {
    artifacts.value = (await getArtifacts()).artifacts;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    loading.value = false;
  }
}

function handleToggle(event: Event): void {
  if ((event as ToggleEvent).newState === "open") void loadArtifacts();
}

async function toggleStar(item: ArtifactLibraryItem, button: HTMLButtonElement): Promise<void> {
  if (saving.value) return;
  saving.value = true;
  error.value = "";
  try {
    const result = await setArtifactStar(item.ref, !item.starred);
    const hadFocus = button === document.activeElement;
    artifacts.value = result.artifacts;
    await nextTick();
    if (hadFocus && document.activeElement === document.body) button.focus();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    saving.value = false;
  }
}
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
      <div v-if="loading" class="artifact-library__status">
        <LoadingIndicator label="Loading artifacts" />
      </div>
      <p v-if="error" class="artifact-library__status artifact-library__error" role="alert">
        {{ error }}
      </p>
      <ul
        v-if="!loading && sorted.length"
        class="artifact-library__list"
        role="list"
        aria-label="Artifacts"
      >
        <ArtifactLibraryRow
          v-for="item in sorted"
          :key="item.ref"
          :item="item"
          :saving="saving"
          @star="toggleStar(item, $event)"
        />
      </ul>
      <p v-else-if="!loading && !error" class="artifact-library__status">No artifacts yet.</p>
    </div>
  </FullPopover>
</template>

<style scoped>
.artifact-library {
  height: 100%;
  overflow-y: auto;
  overscroll-behavior: contain;
  background: var(--color-bg-app);
}

.artifact-library__list {
  max-width: 60rem;
  margin: 0 auto;
  padding: 0;
  list-style: none;
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
