import { watch, type Ref } from "vue";
import { getOpenAIAuthAttemptStatus } from "./api";

export function watchOpenAIAuthAttempt(
  attemptId: Ref<string>,
  onCompleted: () => Promise<void>,
  onError: (error: unknown) => void,
): void {
  watch(attemptId, (id, _previous, onCleanup) => {
    if (!id) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    onCleanup(() => {
      cancelled = true;
      clearTimeout(timer);
    });
    const poll = async () => {
      try {
        const status = await getOpenAIAuthAttemptStatus(id);
        if (cancelled) return;
        if (status.completed) {
          try {
            await onCompleted();
          } catch (error) {
            onError(error);
          }
        } else {
          timer = setTimeout(poll, 1000);
        }
      } catch (error) {
        if (!cancelled) onError(error);
      }
    };
    timer = setTimeout(poll, 1000);
  });
}
