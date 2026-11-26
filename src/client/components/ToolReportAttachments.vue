<script setup lang="ts">
import { FileDiff } from "@lucide/vue";
import { useId } from "vue";
import type { MessagePresentation } from "@/server/message-presentation";
import AgentTurnDiffPopover from "./AgentTurnDiffPopover.vue";
import AttachedFilesList from "./AttachedFilesList.vue";
import SharedSitesList from "./SharedSitesList.vue";

const props = defineProps<{ presentation: MessagePresentation; compact?: boolean }>();
const id = `tool-report-${useId()}`;
</script>

<template>
  <div
    v-if="
      presentation.sentFiles?.length ||
      presentation.sites?.length ||
      presentation.fileChanges?.length
    "
    class="tool-report-attachments"
  >
    <AttachedFilesList
      v-if="presentation.sentFiles?.length"
      :files="presentation.sentFiles"
      :compact="props.compact"
    />
    <SharedSitesList
      v-if="presentation.sites?.length"
      :sites="presentation.sites"
      :id-prefix="id"
    />
    <template v-if="presentation.fileChanges?.length">
      <button type="button" class="chrome-button tool-report-attachments__diff" :popovertarget="id">
        <FileDiff :size="16" aria-hidden="true" />
        View changes {{ presentation.fileChanges.length }}
      </button>
      <AgentTurnDiffPopover :popover-id="id" :files="presentation.fileChanges" />
    </template>
  </div>
</template>

<style scoped>
.tool-report-attachments {
  display: grid;
  gap: 0.45rem;
  min-width: 0;
}

.tool-report-attachments__diff {
  justify-self: start;
}
</style>
