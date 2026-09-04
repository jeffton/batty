<script setup lang="ts">
import type { CodeView, CodeViewItem, CodeViewOptions } from "@pierre/diffs";
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import FullPopover from "@/client/components/FullPopover.vue";
import type { AgentTurnFileChange } from "@/shared/types";

const props = defineProps<{
  popoverId: string;
  files: AgentTurnFileChange[];
}>();

const root = ref<HTMLElement>();
let codeView: CodeView | undefined;
let pierre: typeof import("@pierre/diffs") | undefined;

const options: CodeViewOptions = {
  theme: { dark: "pierre-dark", light: "pierre-light" },
  themeType: "system",
  diffStyle: "unified",
  overflow: "wrap",
  stickyHeaders: true,
  layout: { paddingTop: 12, paddingBottom: 12, gap: 12 },
  unsafeCSS: `
    :host {
      --diffs-font-family: var(--font-family-mono);
      --diffs-header-font-family: var(--font-family-mono);
    }

    [data-line],
    [data-line] span {
      font-weight: 400 !important;
    }

    [data-line-type="change-addition"] {
      --diffs-computed-diff-line-bg: var(--color-diff-add-bg);
    }

    [data-line-type="change-deletion"] {
      --diffs-computed-diff-line-bg: var(--color-diff-remove-bg);
    }

    [data-diff-span] {
      background-color: var(--color-diff-inline);
    }
  `,
};

function buildItems(): CodeViewItem[] {
  return props.files.map((file, index) => ({
    id: file.path,
    type: "diff",
    fileDiff: pierre!.parsePatchFiles(file.patch, `${props.popoverId}:${index}`)[0]!.files[0]!,
  }));
}

async function ensureCodeView(): Promise<void> {
  if (codeView) {
    return;
  }
  const loadedPierre = await import("@pierre/diffs");
  await nextTick();
  if (!root.value || codeView) {
    return;
  }
  pierre = loadedPierre;
  codeView = new loadedPierre.CodeView(options);
  codeView.setup(root.value);
  codeView.setItems(buildItems());
}

function handleToggle(event: Event): void {
  if ((event as Event & { newState?: string }).newState === "open") {
    void ensureCodeView();
  }
}

watch(
  () => props.files,
  () => codeView?.setItems(buildItems()),
);

onBeforeUnmount(() => {
  codeView?.cleanUp();
  codeView = undefined;
});
</script>

<template>
  <FullPopover
    class="agent-turn-diff-popover"
    :popover-id="props.popoverId"
    title="Code changes"
    :subtitle="`${props.files.length} changed ${props.files.length === 1 ? 'file' : 'files'}`"
    close-label="Close code changes"
    @toggle="handleToggle"
  >
    <div ref="root" class="agent-turn-diff-popover__viewer" />
  </FullPopover>
</template>

<style scoped>
.agent-turn-diff-popover__viewer {
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: auto;
  background: var(--color-bg-panel);
}
</style>
