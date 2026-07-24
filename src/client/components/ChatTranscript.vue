<script setup lang="ts">
import { ArrowDown } from "@lucide/vue";
import { Virtualizer } from "virtua/vue";
import { ref } from "vue";
import ChatMessage from "@/client/components/ChatMessage.vue";
import type { TranscriptDisplayEntry } from "@/client/lib/transcript-display";

const props = withDefaults(
  defineProps<{
    historyEntries: TranscriptDisplayEntry[];
    tailEntries: TranscriptDisplayEntry[];
    keptHistoryIndexes: number[];
    isStreaming: boolean;
    isPinnedToBottom: boolean;
    allowSessionPopovers?: boolean;
  }>(),
  {
    allowSessionPopovers: true,
  },
);

const emit = defineEmits<{
  jumpToLatest: [];
  toggleDetails: [sectionKey: string];
}>();

type TranscriptHistoryHandle = InstanceType<typeof Virtualizer>;

const transcript = ref<HTMLElement | null>(null);
const transcriptHistory = ref<TranscriptHistoryHandle | null>(null);
const transcriptTail = ref<HTMLElement | null>(null);
const transcriptBottom = ref<HTMLElement | null>(null);

function entryKey(entry: TranscriptDisplayEntry): string {
  return entry.kind === "message"
    ? `message:${entry.entry.message.id}`
    : `details-toggle:${entry.sectionKey}:${entry.expanded ? "expanded" : "collapsed"}`;
}

function rootElement(): HTMLElement | null {
  return transcript.value;
}

function tailElement(): HTMLElement | null {
  return transcriptTail.value;
}

function bottomElement(): HTMLElement | null {
  return transcriptBottom.value;
}

defineExpose({
  rootElement,
  tailElement,
  bottomElement,
});
</script>

<template>
  <div class="transcript-shell">
    <div ref="transcript" class="transcript" tabindex="0" aria-label="Session transcript">
      <Virtualizer
        v-if="props.historyEntries.length > 0"
        ref="transcriptHistory"
        class="transcript__history"
        :data="props.historyEntries"
        :keep-mounted="props.keptHistoryIndexes"
        :scroll-ref="transcript"
      >
        <template #default="{ item: displayEntry }">
          <div :key="entryKey(displayEntry)" class="transcript__item">
            <ChatMessage
              v-if="displayEntry.kind === 'message'"
              :message="displayEntry.entry.message"
              :tool-states-by-call-id="displayEntry.entry.toolStatesByCallId"
              :show-timestamp="displayEntry.showTimestamp"
              :allow-session-popovers="props.allowSessionPopovers"
            />
            <div v-else class="transcript__details-toggle-row">
              <button
                type="button"
                class="transcript__details-toggle-btn"
                :aria-pressed="displayEntry.expanded"
                @click="emit('toggleDetails', displayEntry.sectionKey)"
              >
                {{ displayEntry.expanded ? "Collapse details" : "Show details" }}
              </button>
            </div>
          </div>
        </template>
      </Virtualizer>

      <div ref="transcriptTail" class="transcript__tail">
        <div
          v-for="displayEntry in props.tailEntries"
          :key="entryKey(displayEntry)"
          class="transcript__item"
        >
          <ChatMessage
            v-if="displayEntry.kind === 'message'"
            :message="displayEntry.entry.message"
            :tool-states-by-call-id="displayEntry.entry.toolStatesByCallId"
            :show-timestamp="displayEntry.showTimestamp"
            :allow-session-popovers="props.allowSessionPopovers"
          />
          <div v-else class="transcript__details-toggle-row">
            <button
              type="button"
              class="transcript__details-toggle-btn"
              :aria-pressed="displayEntry.expanded"
              @click="emit('toggleDetails', displayEntry.sectionKey)"
            >
              {{ displayEntry.expanded ? "Collapse details" : "Show details" }}
            </button>
          </div>
        </div>
        <div ref="transcriptBottom" class="transcript__bottom" aria-hidden="true" />
      </div>
    </div>

    <button
      v-if="props.isStreaming && !props.isPinnedToBottom"
      type="button"
      class="transcript__jump-btn"
      aria-label="Jump to latest"
      title="Jump to latest"
      @click="emit('jumpToLatest')"
    >
      <ArrowDown :size="18" />
    </button>
  </div>
</template>

<style scoped>
.transcript-shell {
  position: relative;
  min-height: 0;
}

.transcript {
  min-height: 0;
  min-width: 0;
  height: 100%;
  overflow: auto;
  overscroll-behavior: contain;
  overflow-anchor: none;
  padding: 0.6rem calc(var(--safe-area-right) + 0.8rem) 0.2rem calc(var(--safe-area-left) + 0.8rem);
  background: var(--color-bg-app);
}

.transcript__history,
.transcript__tail {
  min-width: 0;
}

.transcript__item {
  min-width: 0;
  padding-bottom: 0.8rem;
}

.transcript__bottom {
  width: 100%;
  height: 1px;
}

.transcript__details-toggle-row {
  display: flex;
  justify-content: center;
}

.transcript__details-toggle-btn {
  border: 1px solid color-mix(in srgb, var(--color-info) 30%, transparent);
  border-radius: 0.5rem;
  padding: 0.22rem 0.65rem;
  font: inherit;
  font-size: 0.88rem;
  font-weight: 600;
  cursor: pointer;
  color: var(--color-info);
  background: var(--color-bg-inline-code);
}

.transcript__jump-btn {
  border: 1px solid color-mix(in srgb, var(--color-info) 30%, transparent);
  border-radius: 0.5rem;
  background: var(--color-bg-inline-code);
  color: var(--color-info);
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.18);
  transition:
    background 80ms ease,
    border-color 80ms ease,
    transform 120ms ease,
    color 80ms ease;
  position: absolute;
  left: 50%;
  bottom: 0.9rem;
  transform: translateX(-50%);
  z-index: 2;
  min-width: 2.5rem;
  min-height: 2.5rem;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

@media (hover: hover) {
  .transcript__jump-btn:hover {
    transform: translateX(-50%) translateY(-1px);
  }

  .transcript__details-toggle-btn:hover,
  .transcript__jump-btn:hover {
    background: color-mix(in srgb, var(--color-bg-inline-code) 78%, var(--color-info));
  }
}

.transcript__jump-btn :deep(svg) {
  display: block;
}
</style>
