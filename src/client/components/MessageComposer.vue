<script setup lang="ts">
import { Paperclip, SendHorizontal } from "@lucide/vue";
import { blockAppReload } from "@/client/lib/app-updates";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useId, watch } from "vue";
import ComposerQueuedPrompts from "@/client/components/ComposerQueuedPrompts.vue";
import StreamingStopControl from "@/client/components/StreamingStopControl.vue";
import TasksControl from "@/client/components/TasksControl.vue";
import { clearSessionDraft, readSessionDraft, writeSessionDraft } from "@/client/lib/session-draft";
import type { CronRunLog, QueuedPrompt, RunningSubagent } from "@/shared/types";

const DRAFT_SAVE_INTERVAL_MS = 400;

const props = defineProps<{
  disabled?: boolean;
  actionsDisabled?: boolean;
  streaming?: boolean;
  compacting?: boolean;
  memoryPending?: number;
  memoryError?: string;
  subagents?: RunningSubagent[];
  cronRuns?: CronRunLog[];
  offline?: boolean;
  error?: string;
  sessionKey?: string;
  queuedPrompts?: QueuedPrompt[];
}>();

const emit = defineEmits<{
  submit: [text: string, files: File[]];
  stop: [];
  removeQueuedPrompt: [prompt: QueuedPrompt];
}>();

const textareaId = `chat-message-${useId()}`;
const text = ref("");
const fileInput = ref<HTMLInputElement>();
const textarea = ref<HTMLTextAreaElement>();
const files = shallowRef<File[]>([]);
const fileHashes = new WeakMap<File, string>();
const pendingFiles = ref(0);
const fileError = ref("");
let fileGeneration = 0;
const draftFilesBySessionKey = new Map<string, File[]>();
const dragging = ref(false);
const maxInputHeight = ref(240);
const inputFocused = ref(false);
const actionsDisabled = computed(() => Boolean(props.disabled || props.actionsDisabled));
const hasPayload = computed(() => text.value.trim().length > 0 || files.value.length > 0);
const unblockReload = blockAppReload(
  () =>
    text.value.length > 0 ||
    files.value.length > 0 ||
    pendingFiles.value > 0 ||
    [...draftFilesBySessionKey.values()].some((draft) => draft.length > 0),
);
onBeforeUnmount(unblockReload);

let textareaResizeObserver: ResizeObserver | undefined;
let textareaHeightAnimationFrame: number | undefined;
let measuredTextareaText = "";
let measuredTextareaWidth = 0;

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

async function addFiles(next: FileList | File[]): Promise<void> {
  if (actionsDisabled.value) {
    return;
  }

  const incoming = Array.from(next);
  const generation = fileGeneration;
  resetFileInput();
  fileError.value = "";
  pendingFiles.value += 1;
  try {
    await Promise.all(
      incoming.map(async (file) => {
        const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
        const hash = Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        fileHashes.set(file, hash);
      }),
    );
    if (generation !== fileGeneration) {
      return;
    }

    // Commit synchronously against the latest draft, including overlapping selections.
    const hashes = new Set(files.value.map((file) => fileHashes.get(file)));
    const added = incoming.filter((file) => {
      const hash = fileHashes.get(file)!;
      if (hashes.has(hash)) {
        return false;
      }
      hashes.add(hash);
      return true;
    });
    files.value = [...files.value, ...added];
    if (props.sessionKey) {
      draftFilesBySessionKey.set(props.sessionKey, [...files.value]);
    }
  } catch (error) {
    if (generation === fileGeneration) {
      fileError.value = error instanceof Error ? error.message : String(error);
    }
  } finally {
    if (generation === fileGeneration) {
      pendingFiles.value -= 1;
    }
  }
}

function removeFile(index: number): void {
  files.value = files.value.filter((_, fileIndex) => fileIndex !== index);
  if (props.sessionKey) {
    draftFilesBySessionKey.set(props.sessionKey, [...files.value]);
  }
}

function removeQueuedPrompt(prompt: QueuedPrompt): void {
  emit("removeQueuedPrompt", prompt);
  if (prompt.kind === "followUp" && text.value.trim().length === 0) {
    text.value = prompt.text;
    void nextTick(() => {
      scheduleTextareaHeightSync();
      textarea.value?.focus();
    });
  }
}

function textareaMinHeight(element: HTMLTextAreaElement): number {
  const minHeight = Number.parseFloat(window.getComputedStyle(element).minHeight);
  return Number.isFinite(minHeight) ? minHeight : 0;
}

function syncTextareaHeight(): void {
  const element = textarea.value;
  if (!element) {
    return;
  }

  // Never reset height while text grows, including insertions in the middle of a draft.
  // Setting height to "auto" on each keystroke resizes the transcript viewport and
  // makes streaming auto-follow bounce the chat. Remeasure from scratch when
  // text changes without growing, or when the textarea width changes.
  if (
    element.clientWidth !== measuredTextareaWidth ||
    (element.value !== measuredTextareaText && element.value.length <= measuredTextareaText.length)
  ) {
    element.style.height = "auto";
  }
  const naturalHeight = Math.max(element.scrollHeight, textareaMinHeight(element));
  const nextHeight = Math.min(naturalHeight, maxInputHeight.value);
  if (element.style.height !== `${nextHeight}px`) {
    element.style.height = `${nextHeight}px`;
  }
  element.style.overflowY = naturalHeight > maxInputHeight.value ? "auto" : "hidden";
  measuredTextareaText = element.value;
  measuredTextareaWidth = element.clientWidth;
}

function scheduleTextareaHeightSync(): void {
  if (textareaHeightAnimationFrame != null) {
    window.cancelAnimationFrame(textareaHeightAnimationFrame);
  }

  textareaHeightAnimationFrame = window.requestAnimationFrame(() => {
    textareaHeightAnimationFrame = undefined;
    syncTextareaHeight();
  });
}

let lastEarlyActionAt: number | undefined;

function updateMaxInputHeight(): void {
  maxInputHeight.value = Math.min(Math.max(Math.round(window.innerHeight * 0.34), 160), 320);
  syncTextareaHeight();
}

function loadDraft(sessionKey?: string): void {
  fileGeneration += 1;
  pendingFiles.value = 0;
  fileError.value = "";
  hydratingDraft = true;
  text.value = sessionKey ? readSessionDraft(sessionKey) : "";
  files.value = sessionKey ? [...(draftFilesBySessionKey.get(sessionKey) ?? [])] : [];
  resetFileInput();
  void nextTick(() => {
    hydratingDraft = false;
    scheduleTextareaHeightSync();
  });
}

function clear(): void {
  fileGeneration += 1;
  pendingFiles.value = 0;
  fileError.value = "";
  clearDraftSaveTimeout();
  queuedDraftSessionKey = undefined;
  queuedDraftText = "";
  if (props.sessionKey) {
    clearSessionDraft(props.sessionKey);
    draftFilesBySessionKey.delete(props.sessionKey);
  }
  text.value = "";
  files.value = [];
  resetFileInput();
  void nextTick(scheduleTextareaHeightSync);
}

function restore(sessionKey: string, textValue: string, nextFiles: File[]): void {
  if (
    props.sessionKey === sessionKey &&
    (text.value.length > 0 || files.value.length > 0 || pendingFiles.value > 0)
  ) {
    return;
  }

  writeSessionDraft(sessionKey, textValue);
  draftFilesBySessionKey.set(sessionKey, [...nextFiles]);
  if (props.sessionKey !== sessionKey) {
    return;
  }

  clearDraftSaveTimeout();
  queuedDraftSessionKey = undefined;
  queuedDraftText = "";
  text.value = textValue;
  files.value = [...nextFiles];
  resetFileInput();
  lastDraftSavedAt = Date.now();
  void nextTick(scheduleTextareaHeightSync);
}

function runAction(): void {
  if (!hasPayload.value || actionsDisabled.value || pendingFiles.value > 0) {
    return;
  }

  emit("submit", text.value, [...files.value]);
}

function triggerActionEarly(event: PointerEvent): void {
  if (event.pointerType === "mouse") {
    return;
  }

  event.preventDefault();
  lastEarlyActionAt = Date.now();
  runAction();
}

function triggerActionClick(): void {
  if (lastEarlyActionAt != null && Date.now() - lastEarlyActionAt < 1000) {
    lastEarlyActionAt = undefined;
    return;
  }

  runAction();
}

function onDrop(event: DragEvent): void {
  event.preventDefault();
  dragging.value = false;
  if (actionsDisabled.value || !event.dataTransfer?.files?.length) {
    return;
  }

  void addFiles(event.dataTransfer.files);
}

function onTextareaKeydown(event: KeyboardEvent): void {
  if (event.key !== "Enter") {
    return;
  }

  if (!(event.metaKey || event.ctrlKey)) {
    return;
  }

  event.preventDefault();
  runAction();
}

function openFilePicker(): void {
  if (actionsDisabled.value) {
    return;
  }

  fileInput.value?.click();
}

function onFileInputChange(event: Event): void {
  void addFiles((event.target as HTMLInputElement).files || []);
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
  void nextTick(scheduleTextareaHeightSync);
});

onMounted(() => {
  updateMaxInputHeight();
  scheduleTextareaHeightSync();
  if (typeof ResizeObserver !== "undefined" && textarea.value) {
    textareaResizeObserver = new ResizeObserver(scheduleTextareaHeightSync);
    textareaResizeObserver.observe(textarea.value);
  }
  window.addEventListener("resize", updateMaxInputHeight);
});

onBeforeUnmount(() => {
  flushDraftSave();
  textareaResizeObserver?.disconnect();
  if (textareaHeightAnimationFrame != null) {
    window.cancelAnimationFrame(textareaHeightAnimationFrame);
  }
  window.removeEventListener("resize", updateMaxInputHeight);
});

defineExpose({ clear, restore });
</script>

<template>
  <form
    :class="['composer', dragging ? 'is-dragging' : '', inputFocused ? 'composer--kbd' : '']"
    @submit.prevent="runAction"
    @dragenter.prevent="dragging = true"
    @dragover.prevent
    @dragleave.prevent="dragging = false"
    @drop="onDrop"
  >
    <div class="composer__inner">
      <div v-if="props.error || fileError || props.offline" class="composer__notices">
        <p v-if="props.error" class="composer__notice composer__notice--error">{{ props.error }}</p>
        <p v-if="fileError" class="composer__notice composer__notice--error">{{ fileError }}</p>
        <p v-if="props.offline" class="composer__notice">Offline. Draft saved locally</p>
      </div>

      <ComposerQueuedPrompts
        :prompts="props.queuedPrompts"
        :disabled="props.disabled"
        @remove="removeQueuedPrompt"
      />

      <div v-if="files.length > 0" class="composer__attachments">
        <button
          v-for="(file, index) in files"
          :key="`${file.name}-${index}`"
          class="composer__chip"
          type="button"
          :disabled="props.disabled"
          @click="removeFile(index)"
        >
          {{ file.name }} ×
        </button>
      </div>

      <label :for="textareaId" class="composer__label">Chat message</label>
      <textarea
        :id="textareaId"
        ref="textarea"
        v-model="text"
        class="composer__input"
        name="chat-message"
        rows="1"
        autocomplete="off"
        autocorrect="on"
        spellcheck="true"
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

        <div class="composer__tasks-slot">
          <TasksControl
            :subagents="props.subagents ?? []"
            :cron-runs="props.cronRuns ?? []"
            :memory-pending="props.memoryPending"
            :memory-error="props.memoryError"
            :compacting="props.compacting"
          />
        </div>

        <div class="composer__stop-slot">
          <StreamingStopControl
            v-if="props.streaming"
            :class="[
              'composer__stream-actions',
              {
                'composer__stream-actions--tasks':
                  props.memoryPending ||
                  props.memoryError ||
                  props.compacting ||
                  props.subagents?.length ||
                  props.cronRuns?.length,
              },
            ]"
            :disabled="actionsDisabled"
            @stop="emit('stop')"
          />
        </div>
        <button
          class="composer__icon-button composer__send"
          type="button"
          aria-label="Send prompt"
          title="Send prompt"
          :disabled="!hasPayload || actionsDisabled || pendingFiles > 0"
          @pointerdown="triggerActionEarly($event)"
          @click="triggerActionClick()"
        >
          <SendHorizontal :size="18" />
        </button>
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
  </form>
</template>

<style scoped>
.composer {
  position: relative;
  z-index: 2;
  padding: 0 0 calc(var(--safe-area-bottom) + 0.5rem);
  background: var(--color-bg-instance);
  border-top: 1px solid var(--color-border-soft);
  box-shadow: 0 -0.35rem 0.75rem oklch(0.15 0.02 240 / 0.08);
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

.composer__notices {
  display: grid;
}

.composer__notice {
  margin: 0;
  padding: 0.55rem calc(var(--safe-area-right) + 0.8rem) 0.55rem
    calc(var(--safe-area-left) + 0.8rem);
  border-radius: 0;
  background: var(--color-warning-soft);
  color: var(--color-warning);
  font-size: 0.82rem;
}

.composer__notice--error {
  background: var(--color-error-soft);
  color: var(--color-error);
}

.composer__attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  padding: 0.5rem calc(var(--safe-area-right) + 0.8rem) 0 calc(var(--safe-area-left) + 0.8rem);
}

.composer__chip {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border: 0;
  background: var(--color-bg-elevated);
  color: inherit;
  font-size: 0.85rem;
  padding: 0.3rem 0.5rem;
  border-radius: 999px;
  transition: background 80ms ease;
}

@media (hover: hover) {
  .composer__chip:hover:not(:disabled) {
    background: var(--color-border-soft);
  }
}

@media (prefers-color-scheme: dark) {
  .composer__chip {
    background: var(--color-bg-selection);
    box-shadow: inset 0 0 0 1px var(--color-border-strong);
  }
}

.composer__chip:disabled {
  opacity: 0.5;
}

.composer__label {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

.composer__input {
  display: block;
  width: auto;
  resize: none;
  min-height: calc(1lh + 1.35rem + 1px);
  margin: 0 calc(var(--safe-area-right) + 0.8rem) 0 calc(var(--safe-area-left) + 0.8rem);
  border: 0;
  border-bottom: 1px solid var(--color-border-soft);
  border-radius: 0;
  background: transparent;
  color: inherit;
  padding: 0.85rem 0 0.5rem;
  font-size: 0.95rem;
  line-height: 1.5;
  outline: none;
  transition: border-color 80ms ease;
}

.composer__input:focus {
  border-color: var(--color-accent);
}

.composer__actions-row {
  min-width: 0;
  display: grid;
  grid-template-columns: 44px minmax(44px, 6rem) 44px 44px;
  align-items: center;
  justify-content: space-between;
  padding: 0 calc(var(--safe-area-right) + 0.4rem) 0 calc(var(--safe-area-left) + 0.4rem);
}

.composer__icon-button {
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

@media (hover: hover) {
  .composer__icon-button:hover:not(:disabled) {
    background: var(--color-bg-elevated);
    color: var(--color-text);
  }
}

.composer__icon-button:disabled {
  opacity: 0.4;
}

.composer__icon-button :deep(svg) {
  display: block;
}

.composer__tasks-slot {
  width: 100%;
  max-width: 6rem;
  min-width: 0;
}

.composer__tasks-slot :deep(.tasks-control) {
  width: 100%;
  overflow: hidden;
}

.composer__stop-slot {
  min-height: 44px;
}

.composer__send {
  color: var(--color-accent-strong);
}

.composer__stream-actions {
  position: relative;
}

.composer__stream-actions :deep(.streaming-stop-control__spinner) {
  position: absolute;
  right: calc(100% + 0.3rem);
}

.composer__stream-actions--tasks :deep(.streaming-stop-control__spinner) {
  display: none;
}
</style>
