<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";

defineOptions({ inheritAttrs: false });

const props = defineProps<{
  anchorUp?: boolean;
  anchorDown?: boolean;
  floating?: boolean;
  alignViewportRight?: boolean;
  alignNarrowViewportLeft?: boolean;
  alignAnchorLeft?: boolean;
  boundaryId?: string;
}>();

const emit = defineEmits<{
  toggle: [event: Event];
}>();

const element = ref<HTMLElement | null>(null);
const anchorStyle = ref<Record<string, string>>({});
let stopPositioning: (() => void) | undefined;

function findAnchor(): HTMLElement {
  return document.querySelector<HTMLElement>(`[popovertarget="${CSS.escape(element.value!.id)}"]`)!;
}

function positionAtAnchor(): void {
  const popover = element.value!;
  const anchor = findAnchor();
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
  const anchorLeft = props.alignAnchorLeft ? rect.left : rect.right - width;
  const alignViewportLeft = props.alignNarrowViewportLeft && viewportWidth <= 600;
  const popoverLeft = alignViewportLeft
    ? left + margin
    : props.alignViewportRight
      ? right - width - margin
      : Math.max(left + margin, Math.min(anchorLeft, right - width - margin));
  anchorStyle.value = {
    position: "fixed",
    positionArea: "none",
    positionTryFallbacks: "none",
    top: props.anchorDown ? `${rect.bottom + margin}px` : "auto",
    right: "auto",
    bottom: props.anchorDown ? "auto" : `${window.innerHeight - rect.top + margin}px`,
    left: `${popoverLeft}px`,
    maxWidth: `${right - left - margin * 2}px`,
    maxHeight: `min(var(--anchored-popover-max-height, 32rem), ${Math.max(0, props.anchorDown ? bottom - rect.bottom - margin * 2 : rect.top - top - margin * 2)}px)`,
    margin: "0",
  };
}

function handleBeforeToggle(event: Event): void {
  stopPositioning?.();
  stopPositioning = undefined;
  if ((!props.anchorUp && !props.anchorDown) || (event as ToggleEvent).newState !== "open") return;

  stopPositioning = startPositioning();
}

function startPositioning(): () => void {
  const controller = new AbortController();
  const { signal } = controller;
  const frame = requestAnimationFrame(() => {
    positionAtAnchor();
    const anchor = findAnchor();
    const container = anchor.parentElement!.parentElement!;
    const observer = new ResizeObserver(positionAtAnchor);
    observer.observe(element.value!);
    observer.observe(anchor);
    observer.observe(container);
    if (props.boundaryId) observer.observe(document.getElementById(props.boundaryId)!);
    const layoutObserver = new MutationObserver(positionAtAnchor);
    layoutObserver.observe(container, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    signal.addEventListener(
      "abort",
      () => {
        observer.disconnect();
        layoutObserver.disconnect();
      },
      { once: true },
    );
    window.addEventListener("resize", positionAtAnchor, { signal });
    window.addEventListener("scroll", positionAtAnchor, { signal, capture: true });
    window.visualViewport?.addEventListener("resize", positionAtAnchor, { signal });
    window.visualViewport?.addEventListener("scroll", positionAtAnchor, { signal });
  });
  return () => {
    cancelAnimationFrame(frame);
    controller.abort();
  };
}

onBeforeUnmount(() => stopPositioning?.());

function hidePopover(): void {
  element.value?.hidePopover();
}

defineExpose({ element, hidePopover });
</script>

<template>
  <!-- Teleport isolates ancestor styles. Callers must use :global for their
       unique root class: Vue does not forward caller scope IDs through Teleport. -->
  <Teleport to="body">
    <div
      ref="element"
      class="base-popover"
      :class="{ 'base-popover--floating': props.floating }"
      popover="auto"
      v-bind="$attrs"
      :style="anchorStyle"
      @beforetoggle="handleBeforeToggle"
      @toggle="emit('toggle', $event)"
    >
      <slot />
    </div>
  </Teleport>
</template>

<style scoped>
.base-popover {
  overscroll-behavior: contain;
}

.base-popover--floating {
  border: 1px solid var(--color-chrome-border);
  border-radius: 1rem;
  background: var(--color-bg-overlay);
  color: var(--color-text);
  box-shadow: var(--color-shadow-popover);
}

.base-popover--floating::backdrop {
  background: transparent;
}
</style>
