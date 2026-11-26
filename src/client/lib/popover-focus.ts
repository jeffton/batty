export function setPopoverInitialFocus(event: MouseEvent): void {
  const trigger = event.currentTarget as HTMLButtonElement;
  const popover = trigger.popoverTargetElement;
  if (!popover || popover.matches(":popover-open")) return;
  popover.querySelector("[autofocus]")?.removeAttribute("autofocus");
  if (event.detail === 0) {
    popover.querySelector("[data-popover-initial-focus]")?.setAttribute("autofocus", "");
  } else if (document.activeElement !== trigger) {
    trigger.focus({ preventScroll: true });
  }
}
