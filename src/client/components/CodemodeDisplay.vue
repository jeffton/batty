<script setup lang="ts">
import { PanelRightOpen } from "@lucide/vue";
import { computed, ref, useId } from "vue";
import SubagentSessionPopover from "@/client/components/SubagentSessionPopover.vue";
import CodeBlock from "@/client/components/CodeBlock.vue";
import { createHeadView } from "@/client/lib/tool-output";
import type { ToolExecutionDetails, UiContentBlock } from "@/shared/types";

type NestedCall = {
  id: string;
  name: string;
  args: string;
  status: "running" | "ok" | "error" | "cancelled";
  durationMs?: number;
  error?: string;
  cost?: number;
  subagent?: { workspaceId?: string; sessionPath?: string };
};

const props = withDefaults(
  defineProps<{
    code: string;
    blocks: UiContentBlock[];
    details?: ToolExecutionDetails;
    status?: "running" | "success" | "error";
    compact: boolean;
    allowSessionPopovers?: boolean;
  }>(),
  { allowSessionPopovers: true },
);

const popoverPrefix = `codemode-subagent-${useId()}`;
function popoverId(index: number): string {
  return `${popoverPrefix}-${expanded.value ? index : Math.max(0, calls.value.length - 8) + index}`;
}

const expanded = ref(false);
const codeView = computed(() => createHeadView(props.code.replaceAll("\r", "").trimEnd(), 10));
const calls = computed(() => (props.details?.calls as NestedCall[] | undefined) ?? []);
const visibleCalls = computed(() => (expanded.value ? calls.value : calls.value.slice(-8)));
const output = computed(() => {
  if (props.status === "running") return "";
  const [first, ...rest] = props.blocks;
  const hasHeader =
    first?.type === "text" &&
    /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/.test(first.text);
  return (hasHeader ? rest : props.blocks)
    .filter((block): block is Extract<UiContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
});
const outputView = computed(() => createHeadView(output.value, 5));
const pricedCalls = computed(() => calls.value.filter((call) => call.cost));
const totalCost = computed(() => pricedCalls.value.reduce((sum, call) => sum + call.cost!, 0));
const canExpand = computed(
  () =>
    codeView.value.isTrimmed ||
    outputView.value.isTrimmed ||
    calls.value.length > 8 ||
    calls.value.some((call) => call.args.length > 80 || call.error),
);
const icons = { running: "…", ok: "✓", error: "✗", cancelled: "⊘" };

function duration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function cost(value: number): string {
  return `$${value >= 0.01 ? value.toFixed(2) : value.toPrecision(2)}`;
}
</script>

<template>
  <div class="codemode-display">
    <CodeBlock
      v-if="props.code"
      :code="expanded ? props.code : codeView.text"
      language="javascript"
      :compact="props.compact"
    />
    <div v-if="!expanded && codeView.isTrimmed" class="codemode-display__muted">
      {{ codeView.hiddenLineCount }} more code lines
    </div>
    <div v-if="calls.length" class="codemode-display__calls">
      <div v-if="!expanded && calls.length > 8" class="codemode-display__muted">
        {{ calls.length - 8 }} earlier calls
      </div>
      <!-- Pi gives concurrent running calls the same temporary ID; their array positions are stable. -->
      <div
        v-for="(call, index) in visibleCalls"
        :key="expanded ? index : Math.max(0, calls.length - 8) + index"
        class="codemode-display__call"
      >
        <div class="codemode-display__summary">
          <span :class="`codemode-display__status--${call.status}`" :aria-label="call.status">
            {{ icons[call.status] }}
          </span>
          <span>{{ call.name }}</span>
          <span class="codemode-display__muted">{{
            !expanded && call.args.length > 80 ? `${call.args.slice(0, 77)}...` : call.args
          }}</span>
          <span v-if="call.durationMs !== undefined" class="codemode-display__muted">
            {{ duration(call.durationMs) }}
          </span>
          <span v-if="call.cost" class="codemode-display__muted">{{ cost(call.cost) }}</span>
          <template
            v-if="
              props.allowSessionPopovers &&
              call.name === 'subagent' &&
              call.subagent?.workspaceId &&
              call.subagent?.sessionPath
            "
          >
            <button
              type="button"
              class="codemode-display__session-btn"
              :popovertarget="popoverId(index)"
            >
              <PanelRightOpen :size="14" />
              {{ call.status === "running" ? "Open live session" : "Open session" }}
            </button>
            <SubagentSessionPopover
              :popover-id="popoverId(index)"
              :workspace-id="call.subagent.workspaceId"
              :session-path="call.subagent.sessionPath"
            />
          </template>
        </div>
        <div v-if="expanded && call.error" class="codemode-display__error">{{ call.error }}</div>
      </div>
      <div v-if="pricedCalls.length > 1" class="codemode-display__muted">
        Model calls: {{ cost(totalCost) }}
      </div>
    </div>
    <CodeBlock v-if="output" :code="expanded ? output : outputView.text" :compact="props.compact" />
    <div v-if="!expanded && outputView.isTrimmed" class="codemode-display__muted">
      {{ outputView.hiddenLineCount }} more output lines
    </div>
    <div v-if="props.details?.fullOutputPath" class="codemode-display__muted">
      Full output: {{ props.details.fullOutputPath }}
    </div>
    <div v-if="canExpand" class="codemode-display__control">
      <button type="button" class="tool-call__expand-btn" @click="expanded = !expanded">
        {{ expanded ? "Collapse" : "Show all" }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.codemode-display,
.codemode-display__calls {
  display: grid;
  gap: 0.4rem;
  min-width: 0;
}

.codemode-display__summary {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.codemode-display__calls,
.codemode-display__error {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.88rem;
  overflow-wrap: anywhere;
}

.codemode-display__muted,
.codemode-display__status--cancelled {
  color: var(--color-text-muted);
}

.codemode-display__status--ok {
  color: var(--color-success);
}

.codemode-display__status--running {
  color: var(--color-warning);
}

.codemode-display__status--error,
.codemode-display__error {
  color: var(--color-error);
}

.codemode-display__error {
  padding-left: 1.4rem;
  white-space: pre-wrap;
}

.codemode-display__control {
  display: flex;
  justify-content: center;
}

.codemode-display__session-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  color: var(--color-info);
  background: none;
  border: 0;
  padding: 0;
  font: inherit;
  cursor: pointer;
}

.tool-call__expand-btn {
  color: var(--color-info);
  background: var(--color-bg-inline-code);
  border: 1px solid color-mix(in srgb, var(--color-info) 30%, transparent);
  border-radius: 0.5rem;
  padding: 0.22rem 0.65rem;
  font: inherit;
  font-size: 0.88rem;
  font-weight: 600;
  cursor: pointer;
}
</style>
