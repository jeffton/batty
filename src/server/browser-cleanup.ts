import { workspaceBrowserKey, type BrowserService } from "./browser-service";

export const BROWSER_IDLE_RETENTION_MS = 60 * 60_000;

/** Shared workspace browsers expire on browser inactivity. */
export function createBrowserCleanup(
  browser: Pick<BrowserService, "hasSession" | "expireIdleSession">,
  workspaceIds: () => Promise<readonly string[]>,
) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let pending: Promise<void> | undefined;

  async function sweep() {
    for (const id of await workspaceIds()) {
      const key = workspaceBrowserKey(id);
      if (await browser.hasSession(key))
        await browser.expireIdleSession(key, BROWSER_IDLE_RETENTION_MS);
    }
  }

  return {
    async bind() {
      if (timer) clearInterval(timer);
      await sweep();
      timer = setInterval(() => {
        if (pending) return;
        pending = sweep()
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
