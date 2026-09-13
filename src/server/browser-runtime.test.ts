import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { chromium } from "playwright";
import {
  closeSharedBrowser,
  discardSharedBrowser,
  getSharedBrowser,
  resetSharedBrowserStateForTests,
} from "@/server/browser-runtime";

vi.mock("playwright", () => ({
  chromium: {
    launch: vi.fn(),
  },
}));

function fakeBrowser() {
  return {
    close: vi.fn(async () => undefined),
    isConnected: vi.fn(() => true),
    newContext: vi.fn(),
    on: vi.fn(),
  };
}

afterEach(async () => {
  await closeSharedBrowser();
  resetSharedBrowserStateForTests();
  vi.clearAllMocks();
});

describe("shared browser runtime", () => {
  it("closes a discarded browser before replacing it", async () => {
    const browser = fakeBrowser();
    const replacement = fakeBrowser();
    vi.mocked(chromium.launch)
      .mockResolvedValueOnce(browser as never)
      .mockResolvedValueOnce(replacement as never);

    expect(await getSharedBrowser()).toBe(browser);
    await discardSharedBrowser(browser as never);
    expect(await getSharedBrowser()).toBe(replacement);
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("closes a browser whose launch finishes during shutdown", async () => {
    const browser = fakeBrowser();
    let resolveLaunch!: (value: typeof browser) => void;
    vi.mocked(chromium.launch).mockReturnValue(
      new Promise((resolve) => {
        resolveLaunch = resolve;
      }) as never,
    );

    const launching = getSharedBrowser();
    const closing = closeSharedBrowser();
    await expect(getSharedBrowser()).rejects.toThrow("Browser runtime is shutting down");
    resolveLaunch(browser);

    await expect(launching).resolves.toBe(browser);
    await closing;
    expect(browser.close).toHaveBeenCalledOnce();
  });
});
