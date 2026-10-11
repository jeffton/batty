<script setup lang="ts">
import { Compass, ListOrdered, Paperclip, SendHorizontal } from "@lucide/vue";
import { blockAppReload } from "@/client/lib/app-updates";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import ComposerQueuedPrompts from "@/client/components/ComposerQueuedPrompts.vue";
import ModelConfigSelector from "@/client/components/ModelConfigSelector.vue";
import StreamingStopControl from "@/client/components/StreamingStopControl.vue";
import TasksControl from "@/client/components/TasksControl.vue";
import { clearSessionDraft, readSessionDraft, writeSessionDraft } from "@/client/lib/session-draft";
import type { CronRunLog, ModelOption, QueuedPrompt, RunningSubagent } from "@/shared/types";

const DRAFT_SAVE_INTERVAL_MS = 400;

const props = defineProps<{
  disabled?: boolean;
  actionsDisabled?: boolean;
  streaming?: boolean;
  compacting?: boolean;
  memoryPending?: number;
  subagents?: RunningSubagent[];
  cronRuns?: CronRunLog[];
  offline?: boolean;
  error?: string;
  sessionKey?: string;
  queuedPrompts?: QueuedPrompt[];
  modelPopoverId: string;
  modelPopoverAnchor: string;
  models: ModelOption[];
  currentModelId?: string;
  currentThinkingLevel: string;
  thinkingOptions: string[];
  modelButtonLabel: string;
  thinkingButtonLabel: string;
}>();

const emit = defineEmits<{
  submit: [text: string, files: File[]];
  steer: [text: string, files: File[]];
  stop: [];
  removeQueuedPrompt: [prompt: QueuedPrompt];
  refreshModels: [];
  setModel: [modelId: string];
  setThinkingLevel: [thinkingLevel: string];
}>();

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

let lastEarlyAction:
  | {
      kind: "submit" | "steer";
      at: number;
    }
  | undefined;

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

function runAction(kind: "submit" | "steer"): void {
  if (!hasPayload.value || actionsDisabled.value || pendingFiles.value > 0) {
    return;
  }

  if (kind === "submit") {
    emit("submit", text.value, [...files.value]);
  } else {
    emit("steer", text.value, [...files.value]);
  }
}

function triggerActionEarly(kind: "submit" | "steer", event: PointerEvent): void {
  if (event.pointerType === "mouse") {
    return;
  }

  event.preventDefault();
  lastEarlyAction = { kind, at: Date.now() };
  runAction(kind);
}

function triggerActionClick(kind: "submit" | "steer"): void {
  if (lastEarlyAction?.kind === kind && Date.now() - lastEarlyAction.at < 1000) {
    lastEarlyAction = undefined;
    return;
  }

  runAction(kind);
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
  runAction("submit");
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
  <div
    :class="['composer', dragging ? 'is-dragging' : '', inputFocused ? 'composer--kbd' : '']"
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
          :disabled="props.disabled"
          @click="removeFile(index)"
        >
          {{ file.name }} ×
        </button>
      </div>

      <textarea
        ref="textarea"
        v-model="text"
        class="composer__input"
        name="chat-message"
        aria-label="Chat message"
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

        <TasksControl
          :subagents="props.subagents ?? []"
          :cron-runs="props.cronRuns ?? []"
          :memory-pending="props.memoryPending"
          :compacting="props.compacting"
        />

        <div class="composer__send-actions">
          <StreamingStopControl
            v-if="props.streaming"
            :class="[
              'composer__stream-actions',
              {
                'composer__stream-actions--tasks':
                  props.memoryPending ||
                  props.compacting ||
                  props.subagents?.length ||
                  props.cronRuns?.length,
              },
            ]"
            :disabled="actionsDisabled"
            @stop="emit('stop')"
          />
          <ModelConfigSelector
            :popover-id="props.modelPopoverId"
            :anchor-name="props.modelPopoverAnchor"
            :models="props.models"
            :current-model-id="props.currentModelId"
            :current-thinking-level="props.currentThinkingLevel"
            :thinking-options="props.thinkingOptions"
            :disabled="props.disabled"
            placement="up"
            :model-label="props.modelButtonLabel"
            :effort-label="props.thinkingButtonLabel"
            compact
            @refresh-models="emit('refreshModels')"
            @set-model="emit('setModel', $event)"
            @set-thinking-level="emit('setThinkingLevel', $event)"
          />
          <button
            v-if="props.streaming"
            class="composer__icon-button composer__steer"
            type="button"
            aria-label="Steer prompt"
            title="Steer prompt"
            :disabled="!hasPayload || actionsDisabled || pendingFiles > 0"
            @pointerdown="triggerActionEarly('steer', $event)"
            @click="triggerActionClick('steer')"
          >
            <Compass :size="18" />
          </button>
          <button
            class="composer__icon-button composer__send"
            type="button"
            :aria-label="props.streaming ? 'Queue prompt' : 'Send prompt'"
            :title="props.streaming ? 'Queue prompt' : 'Send prompt'"
            :disabled="!hasPayload || actionsDisabled || pendingFiles > 0"
            @pointerdown="triggerActionEarly('submit', $event)"
            @click="triggerActionClick('submit')"
          >
            <ListOrdered v-if="props.streaming" :size="18" />
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
  position: relative;
  z-index: 2;
  padding: 0 0 calc(var(--safe-area-bottom) + 0.5rem);
  background: var(--color-bg-panel-strong);
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

.composer__chip:disabled {
  opacity: 0.5;
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
  background: var(--color-bg-panel-strong);
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
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 0.25rem;
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
  flex-shrink: 0;
  margin-inline: 0;
}

.composer__stream-actions--tasks :deep(.streaming-stop-control__spinner) {
  display: none;
}

.composer__send-actions {
  min-width: 0;
  flex-shrink: 1;
  justify-content: flex-end;
  margin-left: auto;
}

.composer__send-actions :deep(.model-config-selector__button) {
  min-width: var(--button-size);
  flex-shrink: 1;
}

@media (max-width: 540px) {
  /* Streaming has five actions: reserve their full targets, compact model text. */
  .composer__send-actions:has(.composer__steer) {
    flex-shrink: 0;
  }

  .composer__send-actions:has(.composer__steer) :deep(.model-config-selector__info) {
    display: none;
  }

  .composer__send-actions:has(.composer__steer) :deep(.model-config-selector__button) {
    width: var(--button-size);
    padding: 0;
    grid-template-columns: auto;
    gap: 0;
  }
}
</style>
