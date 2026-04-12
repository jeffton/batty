let installed = false;
let swallowNextClick = false;

function openPopovers(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[popover]")].filter((element) =>
    element.matches(":popover-open"),
  );
}

function isEventInsideOpenPopover(event: Event, popovers: readonly HTMLElement[]): boolean {
  const path = event.composedPath();
  return popovers.some((popover) => path.includes(popover));
}

function closeOpenPopovers(popovers: readonly HTMLElement[]): void {
  for (const popover of popovers) {
    popover.hidePopover?.();
  }
}

function handlePointerDown(event: PointerEvent): void {
  const popovers = openPopovers();
  if (popovers.length === 0) {
    swallowNextClick = false;
    return;
  }

  if (isEventInsideOpenPopover(event, popovers)) {
    swallowNextClick = false;
    return;
  }

  swallowNextClick = true;
  event.preventDefault();
  event.stopImmediatePropagation();
  closeOpenPopovers(popovers);
}

function handleClick(event: MouseEvent): void {
  if (!swallowNextClick) {
    return;
  }

  swallowNextClick = false;
  event.preventDefault();
  event.stopImmediatePropagation();
}

export function installPopoverBackdropClickGuard(): void {
  if (installed) {
    return;
  }

  installed = true;
  document.addEventListener("pointerdown", handlePointerDown, true);
  document.addEventListener("click", handleClick, true);
}
