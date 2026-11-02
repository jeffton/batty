import { entryMessages, type Runtime } from "./runtime";
import type { WebPushService } from "./web-push";

// Observe committed main-thread replies independently of connected browsers.
export function registerPushCompletions(
  runtime: Runtime,
  webPush: WebPushService,
  reportError: (error: unknown) => void,
): () => void {
  let pending = Promise.resolve();
  return runtime.harness.observeCommits({
    advance: (publication) => {
      for (const change of publication.changes) {
        if (change.type !== "entry" || change.value.conversationId !== runtime.main.id) continue;
        const messages = entryMessages([change.value]);
        const assistant = messages.findLast((message) => message.role === "assistant");
        if (!assistant || !["stop", "length"].includes(assistant.stopReason ?? "")) continue;
        pending = pending
          .then(async () => {
            const state = await runtime.state("main", undefined, false);
            await webPush.notifyAgentCompleted({ ...state, messages });
          })
          .catch(reportError);
      }
    },
    end: () => {},
  }).detach;
}
