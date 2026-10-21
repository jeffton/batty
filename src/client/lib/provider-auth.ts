import { watch, type Ref } from "vue";
import { getOpenAIAuthAttemptStatus } from "./api";
import { useAppStore } from "@/client/stores/app";
import { reportBrowserError } from "./browser-errors";

export function watchOpenAIAuthAttempt(
  attemptId: Ref<string>,
  onCompleted: () => Promise<void>,
  onError: (error: unknown) => void,
): void {
  const store = useAppStore();
  let reconciled = "";
  let handled = "";
  watch(
    () =>
      [
        attemptId.value,
        store.authAttemptsVersion,
        store.providerAuthAttempts[attemptId.value],
      ] as const,
    async ([id, version, status], _previous, onCleanup) => {
      if (!id || handled === id) return;
      let cancelled = false;
      onCleanup(() => {
        cancelled = true;
      });
      const finish = async (result: { completed: boolean; error?: string }) => {
        if (result.error) {
          handled = id;
          onError(new Error(result.error));
        } else if (result.completed) {
          handled = id;
          try {
            await onCompleted();
          } catch (error) {
            onError(error);
          }
        }
      };
      if (status) {
        await finish(status);
        return;
      }
      const key = `${id}:${version}`;
      if (reconciled === key) return;
      reconciled = key;
      try {
        const result = await getOpenAIAuthAttemptStatus(id);
        if (!cancelled) await finish(result);
      } catch (error) {
        if (!cancelled) {
          if (error instanceof Error && "status" in error && error.status === 404) {
            handled = id;
            onError(error);
          } else {
            reportBrowserError(error, "fetch");
          }
        }
      }
    },
    { immediate: true },
  );
}
