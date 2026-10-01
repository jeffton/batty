<script setup lang="ts">
import { Trash2, X } from "@lucide/vue";
import { ref, useId } from "vue";
import BasePopover from "@/client/components/BasePopover.vue";

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    label: string;
    disabled?: boolean;
    size?: number;
  }>(),
  { disabled: false, size: 14 },
);

const emit = defineEmits<{ confirm: [] }>();
const id = useId();
const popoverId = `delete-popover-${id}`;
const anchorName = `--delete-anchor-${id}`;
const popover = ref<InstanceType<typeof BasePopover> | null>(null);

function confirm(): void {
  popover.value!.hidePopover();
  emit("confirm");
}
</script>

<template>
  <button
    v-bind="$attrs"
    type="button"
    :aria-label="props.label"
    :disabled="props.disabled"
    :popovertarget="popoverId"
    :style="{ 'anchor-name': anchorName }"
    @click.stop
  >
    <Trash2 :size="props.size" />
  </button>
  <BasePopover
    :id="popoverId"
    ref="popover"
    class="delete-confirmation"
    :style="{ 'position-anchor': anchorName }"
    :aria-label="`Confirm: ${props.label}`"
    @click.stop
  >
    <button
      type="button"
      class="delete-confirmation__button delete-confirmation__button--danger"
      :aria-label="`Confirm: ${props.label}`"
      :title="props.label"
      :disabled="props.disabled"
      @click="confirm"
    >
      <Trash2 :size="16" />
    </button>
    <button
      type="button"
      class="delete-confirmation__button"
      aria-label="Cancel"
      title="Cancel"
      autofocus
      :popovertarget="popoverId"
      popovertargetaction="hide"
    >
      <X :size="16" />
    </button>
  </BasePopover>
</template>

<style scoped>
.delete-confirmation {
  display: none;
}

.delete-confirmation:popover-open {
  position: fixed;
  position-area: block-end span-inline-start;
  position-try-fallbacks:
    block-end span-inline-end,
    block-start span-inline-start,
    block-start span-inline-end;
  display: flex;
  gap: 0.25rem;
  width: max-content;
  margin: 0.35rem 0;
  padding: 0.3rem;
  border: 1px solid var(--color-border-soft);
  border-radius: 0.6rem;
  background: var(--color-bg-overlay);
  color: var(--color-text-strong);
  box-shadow: var(--color-shadow-popover);
}

.delete-confirmation__button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.25rem;
  height: 2.25rem;
  padding: 0;
  border: 0;
  border-radius: 0.4rem;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.delete-confirmation__button--danger {
  background: var(--color-error-soft);
  color: var(--color-error);
}

.delete-confirmation__button:hover {
  background: var(--color-bg-elevated);
}

.delete-confirmation__button--danger:hover {
  background: var(--color-error-soft);
}

.delete-confirmation__button:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}

.delete-confirmation__button:disabled {
  cursor: default;
  opacity: 0.6;
}
</style>
