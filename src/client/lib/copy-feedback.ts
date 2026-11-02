import { onBeforeUnmount, ref } from "vue";

export function useCopyFeedback() {
  const copied = ref(false);
  let timeout: number | undefined;

  function resetCopied(): void {
    window.clearTimeout(timeout);
    timeout = undefined;
    copied.value = false;
  }

  function markCopied(): void {
    resetCopied();
    copied.value = true;
    timeout = window.setTimeout(resetCopied, 1400);
  }

  onBeforeUnmount(resetCopied);
  return { copied, markCopied, resetCopied };
}
