import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationId, Cursor, Harness } from "@earendil-works/pi-durable";
import { workspaceBrowserKey, type BrowserService } from "./browser-service";
import { OrchestrationDoc } from "./orchestration";
import { ArchivedWorker } from "./orchestration-history";

export const BROWSER_IDLE_RETENTION_MS = 60 * 60_000;

/** Shared workspace browsers and legacy conversation browsers expire on browser inactivity. */
export function createWorkerBrowserCleanup(
  browser: Pick<
    BrowserService,
    "hasSession" | "expireIdleSession" | "withSessionLifecycle" | "closeSession"
  >,
  workspaceIds: () => Promise<readonly string[]>,
) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let pending: Promise<void> | undefined;

  async function sweep(harness: Harness) {
    for (const id of await workspaceIds()) {
      const key = workspaceBrowserKey(id);
      if (await browser.hasSession(key))
        await browser.expireIdleSession(key, BROWSER_IDLE_RETENTION_MS);
    }
    // Retain idle cleanup for detached browsers created before workspace sharing.
    let cursor: Cursor | undefined;
    do {
      const page = await harness.commit((tx) => tx.scanConversations({}, 200, cursor), context);
      for (const conversation of page.items) {
        if (await browser.hasSession(String(conversation.id)))
          await browser.expireIdleSession(String(conversation.id), BROWSER_IDLE_RETENTION_MS);
      }
      cursor = page.next;
    } while (cursor);
  }

  return {
    // Worker lifecycle hooks only address legacy numeric conversation keys.
    // Stopping a worker does not end the workspace browser used by its peers.
    async stop(harness: Harness, id: ConversationId, taskId: string) {
      await browser.withSessionLifecycle(String(id), async () => {
        const state = await harness.snapshot(OrchestrationDoc, context);
        const worker =
          state?.workers[String(id)] ??
          (await harness.snapshot(ArchivedWorker, String(id), context));
        // A stop for an old task must not close a browser resumed by a newer task.
        if (String(worker?.active) === taskId) await browser.closeSession(String(id));
      });
    },
    async bind(harness: Harness) {
      if (timer) clearInterval(timer);
      await sweep(harness);
      timer = setInterval(() => {
        if (pending) return;
        pending = sweep(harness)
          .catch((error) => console.error("Browser idle cleanup", error))
          .finally(() => {
            pending = undefined;
          });
      }, 60_000);
      timer.unref();
    },
    async close() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await pending;
    },
  };
}
