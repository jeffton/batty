import { ref } from "vue";

export type Pane = "browser" | "session";

const pendingPaneTransition = ref<Pane>();

export function startPaneTransition(pane: Pane): void {
  pendingPaneTransition.value = pane;
}

export function consumePaneTransition(pane: Pane): boolean {
  const shouldTransition = pendingPaneTransition.value === pane;
  pendingPaneTransition.value = undefined;
  return shouldTransition;
}

export function clearPaneTransition(): void {
  pendingPaneTransition.value = undefined;
}

export function paneTransitionPending(): boolean {
  return pendingPaneTransition.value !== undefined;
}
