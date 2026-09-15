import type { Browser } from "playwright";

let activeBrowser: Browser | null = null;
let browserLaunchPromise: Promise<Browser> | null = null;
let browserClosePromise: Promise<void> | null = null;

async function launchBrowser(): Promise<Browser> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--disable-quic",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    ],
  });

  if (!browser || typeof browser.newContext !== "function") {
    throw new Error("Playwright did not return a browser instance");
  }

  activeBrowser = browser;
  browser.on("disconnected", () => {
    if (activeBrowser === browser) activeBrowser = null;
  });
  return browser;
}

export async function getSharedBrowser(): Promise<Browser> {
  if (browserClosePromise) throw new Error("Browser runtime is shutting down");
  if (activeBrowser?.isConnected()) return activeBrowser;

  activeBrowser = null;
  browserLaunchPromise ??= launchBrowser();
  const launchPromise = browserLaunchPromise;
  try {
    return await launchPromise;
  } finally {
    if (browserLaunchPromise === launchPromise) browserLaunchPromise = null;
  }
}

export async function discardSharedBrowser(browser: Browser): Promise<void> {
  if (activeBrowser === browser) activeBrowser = null;
  await browser.close().catch(() => {});
}

export function isClosedBrowserError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /(?:target page, context or browser|browser) has been closed/i.test(error.message)
  );
}

export async function closeSharedBrowser(): Promise<void> {
  if (browserClosePromise) return browserClosePromise;

  const closePromise = (async () => {
    const browser = activeBrowser;
    const launchPromise = browserLaunchPromise;
    activeBrowser = null;
    browserLaunchPromise = null;

    const launchedBrowser = await launchPromise?.catch(() => null);
    if (activeBrowser === launchedBrowser) activeBrowser = null;
    const browsers = new Set(
      [browser, launchedBrowser].filter((value): value is Browser => !!value),
    );
    await Promise.all([...browsers].map((value) => value.close().catch(() => {})));
  })();
  browserClosePromise = closePromise;
  try {
    await closePromise;
  } finally {
    if (browserClosePromise === closePromise) browserClosePromise = null;
  }
}

export function resetSharedBrowserStateForTests(): void {
  activeBrowser = null;
  browserLaunchPromise = null;
  browserClosePromise = null;
}
