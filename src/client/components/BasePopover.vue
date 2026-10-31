<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    as?: "div" | "form";
    mode?: "auto" | "manual";
    anchorUp?: boolean;
    anchorDown?: boolean;
    floating?: boolean;
    alignViewportRight?: boolean;
    boundaryId?: string;
    dimBackdrop?: boolean;
  }>(),
  {
    as: "div",
    mode: "auto",
  },
);

const emit = defineEmits<{
  toggle: [event: Event];
}>();

const element = ref<HTMLElement | null>(null);
const anchorStyle = ref<Record<string, string>>({});
let observer: ResizeObserver | undefined;
let layoutObserver: MutationObserver | undefined;
let frame: number | undefined;

function positionAtAnchor(): void {
  const popover = element.value!;
  const anchor = document.querySelector<HTMLElement>(
    `[popovertarget="${CSS.escape(popover.id)}"]`,
  )!;
  const rect = anchor.getBoundingClientRect();
  const viewport = window.visualViewport;
  const viewportLeft = viewport?.offsetLeft ?? 0;
  const viewportTop = viewport?.offsetTop ?? 0;
  const viewportWidth = viewport?.width ?? window.innerWidth;
  const boundary = props.boundaryId
    ? document.getElementById(props.boundaryId)!.getBoundingClientRect()
    : undefined;
  const left = Math.max(viewportLeft, boundary?.left ?? viewportLeft);
  const right = Math.min(
    viewportLeft + viewportWidth,
    boundary?.right ?? viewportLeft + viewportWidth,
  );
  const top = Math.max(viewportTop, boundary?.top ?? viewportTop);
  const bottom = Math.min(
    viewportTop + (viewport?.height ?? window.innerHeight),
    boundary?.bottom ?? window.innerHeight,
  );
  const margin = 8;
  const width = Math.min(popover.offsetWidth, right - left - margin * 2);
  anchorStyle.value = {
    position: "fixed",
    positionArea: "none",
    positionTryFallbacks: "none",
    top: props.anchorDown ? `${rect.bottom + margin}px` : "auto",
    right: "auto",
    bottom: props.anchorDown ? "auto" : `${window.innerHeight - rect.top + margin}px`,
    left: `${props.alignViewportRight ? right - width - margin : Math.max(left + margin, Math.min(rect.right - width, right - width - margin))}px`,
    maxWidth: `${right - left - margin * 2}px`,
    maxHeight: `min(var(--anchored-popover-max-height, 32rem), ${Math.max(0, props.anchorDown ? bottom - rect.bottom - margin * 2 : rect.top - top - margin * 2)}px)`,
    margin: "0",
  };
}

function stopPositioning(): void {
  observer?.disconnect();
  layoutObserver?.disconnect();
  window.removeEventListener("resize", positionAtAnchor);
  window.removeEventListener("scroll", positionAtAnchor, true);
  window.visualViewport?.removeEventListener("resize", positionAtAnchor);
  window.visualViewport?.removeEventListener("scroll", positionAtAnchor);
  if (frame !== undefined) cancelAnimationFrame(frame);
}

function handleBeforeToggle(event: Event): void {
  if (!props.anchorUp && !props.anchorDown) return;
  stopPositioning();
  if ((event as ToggleEvent).newState !== "open") return;
  frame = requestAnimationFrame(() => {
    positionAtAnchor();
    observer = new ResizeObserver(positionAtAnchor);
    observer.observe(element.value!);
    const anchor = document.querySelector<HTMLElement>(
      `[popovertarget="${CSS.escape(element.value!.id)}"]`,
    )!;
    observer.observe(anchor);
    const container = anchor.parentElement!.parentElement!;
    observer.observe(container);
    if (props.boundaryId) observer.observe(document.getElementById(props.boundaryId)!);
    layoutObserver = new MutationObserver(positionAtAnchor);
    layoutObserver.observe(container, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    window.addEventListener("resize", positionAtAnchor);
    window.addEventListener("scroll", positionAtAnchor, true);
    window.visualViewport?.addEventListener("resize", positionAtAnchor);
    window.visualViewport?.addEventListener("scroll", positionAtAnchor);
  });
}

onBeforeUnmount(stopPositioning);

function showPopover(): void {
  element.value?.showPopover();
}

function hidePopover(): void {
  element.value?.hidePopover();
}

function togglePopover(force?: boolean): void {
  element.value?.togglePopover(force);
}

defineExpose({ element, showPopover, hidePopover, togglePopover });
</script>

<template>
  <!-- Teleport isolates ancestor styles. Callers must use :global for their
       unique root class: Vue does not forward caller scope IDs through Teleport. -->
  <Teleport to="body">
    <component
      :is="props.as"
      ref="element"
      :class="[
        'base-popover',
        { 'base-popover--dimmed': props.dimBackdrop, 'base-popover--floating': props.floating },
      ]"
      :popover="props.mode"
      v-bind="$attrs"
      :style="anchorStyle"
      @beforetoggle="handleBeforeToggle"
      @toggle="emit('toggle', $event)"
    >
      <slot />
    </component>
  </Teleport>
</template>

<style scoped>
.base-popover {
  overscroll-behavior: contain;
}

.base-popover--floating {
  border: 1px solid var(--color-border-soft);
  border-radius: 0.75rem;
  background: var(--color-bg-overlay);
  color: var(--color-text);
  box-shadow: var(--color-shadow-popover);
}

.base-popover--floating::backdrop {
  background: transparent;
}

.base-popover--dimmed::backdrop {
  background: var(--color-backdrop);
}
</style>
