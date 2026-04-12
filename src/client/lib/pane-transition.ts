import { ref } from "vue";

export type PaneTransition = "" | "slide-from-right" | "slide-from-left";

const paneTransitionName = ref<PaneTransition>("");

export function usePaneTransition() {
  function setPaneTransition(name: PaneTransition): void {
    paneTransitionName.value = name;
  }

  function clearPaneTransitionSoon(): void {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        paneTransitionName.value = "";
      });
    });
  }

  return {
    paneTransitionName,
    setPaneTransition,
    clearPaneTransitionSoon,
  };
}
