<script setup lang="ts">
import { Compass, ListOrdered, Paperclip, SendHorizontal, Square } from "lucide-vue-next";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = defineProps<{
  disabled?: boolean;
  streaming?: boolean;
}>();

const emit = defineEmits<{
  submit: [text: string, files: File[]];
  steer: [text: string, files: File[]];
  stop: [];
}>();

const text = ref("");
const fileInput = ref<HTMLInputElement>();
const textarea = ref<HTMLTextAreaElement>();
const files = ref<File[]>([]);
const dragging = ref(false);
const maxInputHeight = ref(240);

const hasPayload = computed(() => text.value.trim().length > 0 || files.value.length > 0);

function addFiles(next: FileList | File[]): void {
  files.value = [...files.value, ...Array.from(next)];
}

function removeFile(index: number): void {
  files.value.splice(index, 1);
}

function syncTextareaHeight(): void {
  const element = textarea.value;
  if (!element) {
    return;
  }

  element.style.height = "auto";
  const nextHeight = Math.min(element.scrollHeight, maxInputHeight.value);
  element.style.height = `${Math.max(nextHeight, 56)}px`;
  element.style.overflowY = element.scrollHeight > maxInputHeight.value ? "auto" : "hidden";
}

function updateMaxInputHeight(): void {
  if (typeof window === "undefined") {
    maxInputHeight.value = 240;
    return;
  }

  maxInputHeight.value = Math.min(Math.max(Math.round(window.innerHeight * 0.34), 160), 320);
  syncTextareaHeight();
}

function clear(): void {
  text.value = "";
  files.value = [];
  void nextTick(syncTextareaHeight);
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

function onTextareaKeydown(event: KeyboardEvent): void {
  if (event.key !== "Enter") {
    return;
  }

  if (!(event.metaKey || event.ctrlKey)) {
    return;
  }

  event.preventDefault();
  submit();
}

watch(text, () => {
  void nextTick(syncTextareaHeight);
});

onMounted(() => {
  updateMaxInputHeight();
  window.addEventListener("resize", updateMaxInputHeight);
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", updateMaxInputHeight);
});
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

    <textarea
      ref="textarea"
      v-model="text"
      class="composer__input"
      rows="1"
      :disabled="props.disabled"
      @input="syncTextareaHeight"
      @keydown="onTextareaKeydown"
    />

    <div class="composer__actions-row">
      <button
        class="composer__icon-button composer__attach"
        type="button"
        aria-label="Add files"
        title="Add files"
        @click="fileInput?.click()"
      >
        <Paperclip :size="18" />
      </button>

      <div v-if="props.streaming" class="composer__stream-actions" aria-label="Working controls">
        <span class="spinner composer__stream-spinner" aria-hidden="true" />
        <button
          class="composer__stop"
          type="button"
          aria-label="Stop"
          title="Stop"
          @click="emit('stop')"
        >
          <Square :size="16" />
        </button>
      </div>

      <div class="composer__send-actions">
        <button
          v-if="props.streaming"
          class="composer__icon-button composer__steer"
          type="button"
          aria-label="Steer prompt"
          title="Steer prompt"
          :disabled="!hasPayload || props.disabled"
          @click="steer"
        >
          <Compass :size="18" />
        </button>
        <button
          class="composer__icon-button composer__send"
          type="button"
          :aria-label="props.streaming ? 'Queue prompt' : 'Send prompt'"
          :title="props.streaming ? 'Queue prompt' : 'Send prompt'"
          :disabled="!hasPayload || props.disabled"
          @click="submit"
        >
          <ListOrdered v-if="props.streaming" :size="18" />
          <SendHorizontal v-else :size="18" />
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
  </div>
</template>

<style scoped>
.composer {
  padding: 0.55rem 0.65rem;
  display: grid;
  gap: 0.5rem;
  border: 0;
  border-radius: 0;
  box-shadow: none;
  backdrop-filter: none;
  background: rgba(18, 22, 29, 0.96);
}

.is-dragging {
  background: rgba(33, 38, 45, 0.96);
}

.composer__attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.composer__chip,
.composer__icon-button,
.composer__stop {
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(22, 27, 34, 0.9);
  color: inherit;
  font-size: 0.9rem;
}

.composer__icon-button,
.composer__stop {
  min-width: 2.75rem;
  min-height: 2.75rem;
  padding: 0;
  border-radius: 0.7rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.composer__stop {
  background: rgba(127, 29, 29, 0.18);
  border-color: rgba(248, 113, 113, 0.22);
}

.composer__chip,
.composer__icon-button,
.composer__stop,
.composer__input {
  outline: none;
  transition:
    border-color 0.14s ease,
    background-color 0.14s ease,
    box-shadow 0.14s ease;
}

.composer__chip {
  padding: 0.35rem 0.55rem;
  border-radius: 999px;
}

.composer__input {
  width: 100%;
  resize: none;
  min-height: 3.75rem;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 0.7rem;
  background: rgba(13, 17, 23, 0.72);
  color: inherit;
  padding: 0.75rem 0.8rem;
  font-size: 16px;
  line-height: 1.45;
}

.composer__chip:focus-visible,
.composer__icon-button:focus-visible,
.composer__stop:focus-visible,
.composer__input:focus-visible {
  border-color: rgba(147, 197, 253, 0.38);
  box-shadow: 0 0 0 2px rgba(147, 197, 253, 0.14);
}

.composer__input:focus-visible {
  background: rgba(13, 17, 23, 0.84);
}

.composer__actions-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.composer__stream-actions,
.composer__send-actions {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
}

.composer__stream-actions {
  margin-inline: auto;
}

.composer__send-actions {
  justify-content: flex-end;
  margin-left: auto;
}

.composer__stream-spinner {
  width: 1rem;
  height: 1rem;
  border-width: 2px;
}

.composer__send {
  background: rgba(46, 160, 67, 0.16);
}

.composer__steer {
  background: rgba(251, 191, 36, 0.12);
}

.composer__icon-button:disabled,
.composer__stop:disabled {
  opacity: 0.55;
}

.composer__icon-button :deep(svg) {
  display: block;
}
</style>
