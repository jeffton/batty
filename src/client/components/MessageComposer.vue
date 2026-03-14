<script setup lang="ts">
import { computed, ref } from "vue";

const props = defineProps<{
  disabled?: boolean;
  streaming?: boolean;
}>();

const emit = defineEmits<{
  submit: [text: string, files: File[]];
  steer: [text: string, files: File[]];
}>();

const text = ref("");
const fileInput = ref<HTMLInputElement>();
const files = ref<File[]>([]);
const dragging = ref(false);

const hasPayload = computed(() => text.value.trim().length > 0 || files.value.length > 0);

function addFiles(next: FileList | File[]): void {
  files.value = [...files.value, ...Array.from(next)];
}

function removeFile(index: number): void {
  files.value.splice(index, 1);
}

function clear(): void {
  text.value = "";
  files.value = [];
}

function submit(): void {
  if (!hasPayload.value || props.disabled) {
    return;
  }
  emit("submit", text.value, files.value);
  clear();
}

function steer(): void {
  if (!hasPayload.value || props.disabled) {
    return;
  }
  emit("steer", text.value, files.value);
  clear();
}

function onDrop(event: DragEvent): void {
  event.preventDefault();
  dragging.value = false;
  if (event.dataTransfer?.files?.length) {
    addFiles(event.dataTransfer.files);
  }
}
</script>

<template>
  <div
    :class="['composer panel', dragging ? 'is-dragging' : '']"
    @dragenter.prevent="dragging = true"
    @dragover.prevent
    @dragleave.prevent="dragging = false"
    @drop="onDrop"
  >
    <div v-if="files.length > 0" class="composer__attachments">
      <button
        v-for="(file, index) in files"
        :key="`${file.name}-${index}`"
        class="composer__chip"
        @click="removeFile(index)"
      >
        {{ file.name }} ×
      </button>
    </div>
    <div class="composer__row">
      <button class="composer__plus" type="button" @click="fileInput?.click()">+</button>
      <textarea
        v-model="text"
        class="composer__input"
        rows="3"
        placeholder="Ask Pi to code, read files, run tests, or mutate reality a tiny bit."
        :disabled="props.disabled"
        @keydown.enter.exact.prevent="submit"
      />
      <div class="composer__actions">
        <button
          class="composer__send"
          type="button"
          :disabled="!hasPayload || props.disabled"
          @click="submit"
        >
          {{ props.streaming ? "Queue" : "Send" }}
        </button>
        <button
          v-if="props.streaming"
          class="composer__steer"
          type="button"
          :disabled="!hasPayload || props.disabled"
          @click="steer"
        >
          Steer
        </button>
      </div>
    </div>
    <input
      ref="fileInput"
      hidden
      type="file"
      multiple
      @change="addFiles(($event.target as HTMLInputElement).files || [])"
    />
    <div class="composer__hint muted">
      Shift+Enter for newline, Enter to send, drag & drop files or screenshots anywhere in here.
    </div>
  </div>
</template>

<style scoped>
.composer {
  padding: 0.55rem 0.65rem;
  display: grid;
  gap: 0.5rem;
}

.is-dragging {
  border-color: rgba(255, 255, 255, 0.18);
  background: rgba(33, 38, 45, 0.9);
}

.composer__row {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 0.5rem;
  align-items: stretch;
}

.composer__attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.composer__chip,
.composer__plus,
.composer__send,
.composer__steer {
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(22, 27, 34, 0.9);
  color: inherit;
  border-radius: 0.45rem;
  font-size: 0.84rem;
}

.composer__chip {
  padding: 0.25rem 0.45rem;
}

.composer__plus {
  width: 2.15rem;
  font-size: 1rem;
}

.composer__input {
  width: 100%;
  resize: vertical;
  min-height: 4.2rem;
  max-height: 12rem;
  border-radius: 0.45rem;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(13, 17, 23, 0.62);
  color: inherit;
  padding: 0.6rem 0.65rem;
  font-size: 0.88rem;
}

.composer__actions {
  display: grid;
  gap: 0.35rem;
  align-content: start;
}

.composer__send,
.composer__steer {
  padding: 0.55rem 0.7rem;
}

.composer__send {
  background: rgba(46, 160, 67, 0.16);
}

.composer__steer {
  background: rgba(251, 191, 36, 0.12);
}

.composer__hint {
  font-size: 0.76rem;
}

@media (max-width: 720px) {
  .composer__row {
    grid-template-columns: 1fr;
  }

  .composer__actions {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .composer__plus {
    width: 100%;
    min-height: 2.15rem;
  }
}
</style>
