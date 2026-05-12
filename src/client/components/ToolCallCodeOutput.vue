<script setup lang="ts">
import CodeBlock from "@/client/components/CodeBlock.vue";

const props = withDefaults(
  defineProps<{
    code: string;
    language?: string;
    compact?: boolean;
    collapsed?: boolean;
    canExpand?: boolean;
    expandButtonLabel?: string;
    command?: string;
    buttonPlacement?: "before" | "after" | "overlay";
  }>(),
  {
    language: undefined,
    compact: false,
    collapsed: false,
    canExpand: false,
    expandButtonLabel: "",
    command: undefined,
    buttonPlacement: "after",
  },
);

const emit = defineEmits<{
  toggleExpanded: [];
}>();
</script>

<template>
  <div
    :class="props.buttonPlacement === 'overlay' ? 'tool-call__overlay-output' : 'tool-call__bash'"
  >
    <CodeBlock
      v-if="props.command"
      :code="`$ ${props.command}`"
      language="bash"
      :compact="props.compact"
    />

    <div
      v-if="props.canExpand && props.buttonPlacement === 'overlay'"
      class="tool-call__overlay-control"
    >
      <button type="button" class="tool-call__expand-btn" @click="emit('toggleExpanded')">
        {{ props.expandButtonLabel }}
      </button>
    </div>

    <div v-if="props.canExpand && props.buttonPlacement === 'before'" class="tool-call__expand-row">
      <button type="button" class="tool-call__expand-btn" @click="emit('toggleExpanded')">
        {{ props.expandButtonLabel }}
      </button>
    </div>

    <div
      v-if="props.code.trim().length > 0"
      :class="[
        'tool-call__output-window',
        props.collapsed ? 'tool-call__output-window--collapsed' : '',
      ]"
    >
      <CodeBlock :code="props.code" :language="props.language" :compact="props.compact" />
    </div>

    <div v-if="props.canExpand && props.buttonPlacement === 'after'" class="tool-call__expand-row">
      <button type="button" class="tool-call__expand-btn" @click="emit('toggleExpanded')">
        {{ props.expandButtonLabel }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.tool-call__bash {
  display: grid;
  gap: 0.4rem;
}

.tool-call__overlay-output {
  position: relative;
  padding-top: 0.4rem;
}

.tool-call__output-window {
  min-width: 0;
}

.tool-call__output-window--collapsed {
  display: flex;
  align-items: flex-end;
  /* Keep this in sync with OUTPUT_TAIL_LINE_COUNT in ToolCallBlock.vue.
     20lh reserves exactly 20 visible line boxes for the truncated output so the
     transcript height does not bob while the tail window drops old lines and adds new ones. */
  min-height: 20lh;
  max-height: 20lh;
  overflow: hidden;
}

.tool-call__overlay-control,
.tool-call__expand-row {
  display: flex;
  justify-content: center;
  z-index: 1;
}

.tool-call__overlay-control {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
}

.tool-call__expand-row {
  margin: -0.05rem 0;
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

@media (hover: hover) {
  .tool-call__expand-btn:hover {
    background: color-mix(in srgb, var(--color-bg-inline-code) 78%, var(--color-info));
  }
}
</style>
