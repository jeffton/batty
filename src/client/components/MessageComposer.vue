<script setup lang="ts">
import {
  Compass,
  ListOrdered,
  LoaderCircle,
  Paperclip,
  SendHorizontal,
  Square,
} from "lucide-vue-next";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { clearSessionDraft, readSessionDraft, writeSessionDraft } from "@/client/lib/session-draft";

const DRAFT_SAVE_INTERVAL_MS = 400;

const props = defineProps<{
  disabled?: boolean;
  actionsDisabled?: boolean;
  actionPending?: boolean;
  streaming?: boolean;
  offline?: boolean;
  sessionKey?: string;
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
const inputFocused = ref(false);
const actionsDisabled = computed(() =>
  Boolean(props.disabled || props.actionsDisabled || props.actionPending),
);
const hasPayload = computed(() => text.value.trim().length > 0 || files.value.length > 0);

let draftSaveTimeout: number | undefined;
let queuedDraftSessionKey: string | undefined;
let queuedDraftText = "";
let lastDraftSavedAt = 0;
let hydratingDraft = false;

function clearDraftSaveTimeout(): void {
  if (draftSaveTimeout == null) {
    return;
  }

  window.clearTimeout(draftSaveTimeout);
  draftSaveTimeout = undefined;
}

function persistDraft(sessionKey: string, draftText: string): void {
  clearDraftSaveTimeout();
  queuedDraftSessionKey = undefined;
  queuedDraftText = "";
  writeSessionDraft(sessionKey, draftText);
  lastDraftSavedAt = Date.now();
}

function flushDraftSave(): void {
  if (!queuedDraftSessionKey) {
    clearDraftSaveTimeout();
    return;
  }

  persistDraft(queuedDraftSessionKey, queuedDraftText);
}

function scheduleDraftSave(): void {
  const sessionKey = props.sessionKey;
  if (!sessionKey) {
    return;
  }

  const draftText = text.value;
  const now = Date.now();
  const elapsed = now - lastDraftSavedAt;

  if (elapsed >= DRAFT_SAVE_INTERVAL_MS) {
    persistDraft(sessionKey, draftText);
    return;
  }

  queuedDraftSessionKey = sessionKey;
  queuedDraftText = draftText;
  clearDraftSaveTimeout();
  draftSaveTimeout = window.setTimeout(() => {
    if (queuedDraftSessionKey) {
      persistDraft(queuedDraftSessionKey, queuedDraftText);
    }
  }, DRAFT_SAVE_INTERVAL_MS - elapsed);
}

function resetFileInput(): void {
  if (fileInput.value) {
    fileInput.value.value = "";
  }
}

function addFiles(next: FileList | File[]): void {
  if (actionsDisabled.value) {
    return;
  }

  files.value = [...files.value, ...Array.from(next)];
  resetFileInput();
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

function loadDraft(sessionKey?: string): void {
  hydratingDraft = true;
  text.value = sessionKey ? readSessionDraft(sessionKey) : "";
  files.value = [];
  resetFileInput();
  void nextTick(() => {
    hydratingDraft = false;
    syncTextareaHeight();
  });
}

function clear(): void {
  clearDraftSaveTimeout();
  queuedDraftSessionKey = undefined;
  queuedDraftText = "";
  if (props.sessionKey) {
    clearSessionDraft(props.sessionKey);
  }
  text.value = "";
  files.value = [];
  resetFileInput();
  void nextTick(syncTextareaHeight);
}

function submit(): void {
  if (!hasPayload.value || actionsDisabled.value) {
    return;
  }

  emit("submit", text.value, [...files.value]);
}

function steer(): void {
  if (!hasPayload.value || actionsDisabled.value) {
    return;
  }

  emit("steer", text.value, [...files.value]);
}

function onDrop(event: DragEvent): void {
  event.preventDefault();
  dragging.value = false;
  if (actionsDisabled.value || !event.dataTransfer?.files?.length) {
    return;
  }

  addFiles(event.dataTransfer.files);
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

function openFilePicker(): void {
  if (actionsDisabled.value) {
    return;
  }

  fileInput.value?.click();
}

function onFileInputChange(event: Event): void {
  addFiles((event.target as HTMLInputElement).files || []);
}

watch(
  () => props.sessionKey,
  (sessionKey) => {
    flushDraftSave();
    loadDraft(sessionKey);
  },
  { immediate: true },
);

watch(text, () => {
  if (!hydratingDraft) {
    scheduleDraftSave();
  }
  void nextTick(syncTextareaHeight);
});

onMounted(() => {
  updateMaxInputHeight();
  window.addEventListener("resize", updateMaxInputHeight);
});

onBeforeUnmount(() => {
  flushDraftSave();
  window.removeEventListener("resize", updateMaxInputHeight);
});

defineExpose({ clear });
</script>

<template>
  <div
    :class="['composer', dragging ? 'is-dragging' : '', inputFocused ? 'composer--kbd' : '']"
    @dragenter.prevent="dragging = true"
    @dragover.prevent
    @dragleave.prevent="dragging = false"
    @drop="onDrop"
  >
    <div class="composer__inner">
      <p v-if="props.offline" class="composer__notice muted">
        Offline — sending, queueing, and attachments are disabled. Draft saved locally.
      </p>

      <div v-if="files.length > 0" class="composer__attachments">
        <button
          v-for="(file, index) in files"
          :key="`${file.name}-${index}`"
          class="composer__chip"
          :disabled="props.disabled || props.actionPending"
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
        @focus="inputFocused = true"
        @blur="inputFocused = false"
        @input="syncTextareaHeight"
        @keydown="onTextareaKeydown"
      />

      <div class="composer__actions-row">
        <button
          class="composer__icon-button"
          type="button"
          aria-label="Add files"
          title="Add files"
          :disabled="actionsDisabled"
          @click="openFilePicker"
        >
          <Paperclip :size="18" />
        </button>

        <div v-if="props.streaming" class="composer__stream-actions">
          <span class="spinner composer__stream-spinner" aria-hidden="true" />
          <button
            class="composer__icon-button composer__stop"
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
            :disabled="!hasPayload || actionsDisabled"
            @click="steer"
          >
            <LoaderCircle v-if="props.actionPending" :size="18" class="composer__spin-icon" />
            <Compass v-else :size="18" />
          </button>
          <button
            class="composer__icon-button composer__send"
            type="button"
            :aria-label="props.streaming ? 'Queue prompt' : 'Send prompt'"
            :title="props.streaming ? 'Queue prompt' : 'Send prompt'"
            :disabled="!hasPayload || actionsDisabled"
            @click="submit"
          >
            <LoaderCircle v-if="props.actionPending" :size="18" class="composer__spin-icon" />
            <ListOrdered v-else-if="props.streaming" :size="18" />
            <SendHorizontal v-else :size="18" />
          </button>
        </div>
      </div>
    </div>

    <input
      ref="fileInput"
      hidden
      type="file"
      multiple
      :disabled="actionsDisabled"
      @change="onFileInputChange"
    />
  </div>
</template>

<style scoped>
.composer {
  padding: 0.4rem calc(var(--safe-area-right) + 0.8rem) calc(var(--safe-area-bottom) + 0.5rem)
    calc(var(--safe-area-left) + 0.8rem);
  background: var(--color-bg-panel);
  border-top: 1px solid var(--color-border-soft);
}

.composer--kbd {
  padding-bottom: 0.5rem;
}

.is-dragging {
  background: var(--color-accent-soft);
}

.composer__inner {
  display: grid;
  gap: 0.4rem;
}

.composer__notice {
  margin: 0;
  font-size: 0.82rem;
}

.composer__attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
}

.composer__chip {
  border: 0;
  background: var(--color-bg-elevated);
  color: inherit;
  font-size: 0.85rem;
  padding: 0.3rem 0.5rem;
  border-radius: 999px;
  transition: background 80ms ease;
}

.composer__chip:hover:not(:disabled) {
  background: var(--color-border-soft);
}

.composer__chip:disabled {
  opacity: 0.5;
}

.composer__input {
  width: 100%;
  resize: none;
  min-height: 3.5rem;
  border: 1px solid var(--color-border-soft);
  border-radius: 0.6rem;
  background: var(--color-bg-app);
  color: inherit;
  padding: 0.65rem 0.75rem;
  font-size: 0.95rem;
  line-height: 1.5;
  outline: none;
  transition: border-color 80ms ease;
}

.composer__input:focus {
  border-color: var(--color-accent);
}

.composer__actions-row {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 0.4rem;
}

.composer__icon-button {
  min-width: 2.5rem;
  min-height: 2.5rem;
  padding: 0;
  border: 0;
  border-radius: 0.5rem;
  background: transparent;
  color: var(--color-text-muted);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition:
    background 80ms ease,
    color 80ms ease;
}

.composer__icon-button:hover:not(:disabled) {
  background: var(--color-bg-elevated);
  color: var(--color-text);
}

.composer__icon-button:disabled {
  opacity: 0.4;
}

.composer__icon-button :deep(svg) {
  display: block;
}

.composer__stop {
  color: var(--color-error);
}

.composer__send {
  color: var(--color-accent-strong);
}

.composer__steer {
  color: var(--color-warning);
}

.composer__stream-actions,
.composer__send-actions {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
}

.composer__stream-actions {
  justify-self: center;
}

.composer__send-actions {
  justify-content: flex-end;
  justify-self: end;
}

.composer__stream-spinner {
  width: 1rem;
  height: 1rem;
  border-width: 2px;
}

.composer__spin-icon {
  animation: composer-spin 0.85s linear infinite;
}

@keyframes composer-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
