// @vitest-environment node
import path from "node:path";
import { fixtureOperation } from "../test/socket-fixture";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { closeBrowserFixtureServer, createBrowserFixtureServer } from "../test/browser-fixture";

let browser: Browser;
let server: ViteDevServer;
let url: string;
beforeAll(async () => {
  server = await createBrowserFixtureServer("src/client/lib/InstallationStorage.fixture.html", {
    resolve: { alias: { "@": path.resolve("src") } },
    define: { __BATTY_BUILD_ID__: JSON.stringify("dev") },
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  url = `${server.resolvedUrls!.local[0]}src/client/lib/InstallationStorage.fixture.html`;
  browser = await chromium.launch({ headless: true });
}, 30_000);
afterAll(async () => {
  await browser?.close();
  if (server) await closeBrowserFixtureServer(server);
});
async function open(context: BrowserContext, base: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${url}?base=${encodeURIComponent(base)}`);
  await page.waitForFunction(() => Boolean((window as any).fixture));
  return page;
}
async function seed(page: Page, text: string): Promise<void> {
  await page.evaluate(async (text) => {
    const { cache, drafts, retries } = (window as any).fixture;
    drafts.writeSessionDraft("1", text);
    retries.retainPromptRetry("1", "prompt", text, [], `receipt-${text}`);
    await cache.saveMainCache(
      { authenticated: true, cacheScope: text, cacheExpiresAt: Date.now() + 60_000 },
      {
        id: "1",
        streamId: text,
        revision: 1,
        totalMessageCount: 1,
        messages: [
          { id: "1", role: "user", timestamp: Date.now(), blocks: [{ type: "text", text }] },
        ],
      },
    );
  }, text);
}
async function snapshot(page: Page) {
  return page.evaluate(async () => {
    const { cache, drafts } = (window as any).fixture;
    return { draft: drafts.readSessionDraft("1"), cached: await cache.readMainCache() };
  });
}

test("Chromium isolates root, sibling and nested installs through logout, reload and shared-tab revocation", async () => {
  const context = await browser.newContext();
  try {
    const root = await open(context, "/");
    const main = await open(context, "/batty");
    const safe = await open(context, "/batty-safe");
    const nested = await open(context, "/batty/safe");
    const same = await open(context, "/batty/");
    const pages = [root, main, safe, nested];
    await Promise.all(pages.map((page, i) => seed(page, `install-${i}`)));
    expect((await snapshot(same)).draft).toBe("install-1");
    await main.evaluate(async () => {
      const { cache, drafts, retries } = (window as any).fixture;
      drafts.clearSessionDraft("1");
      retries.clearPromptRetry("1", "receipt-install-1");
      await cache.clearMainCache("logged-out");
    });
    // The same installation sees revocation, and its stale writer cannot restore history.
    await seed(same, "stale");
    expect((await snapshot(same)).cached).toBeUndefined();
    for (const i of [0, 2, 3]) {
      const page = pages[i]!;
      await page.reload();
      await page.waitForFunction(() => Boolean((window as any).fixture));
      const result = await snapshot(page);
      expect(result.draft).toBe(`install-${i}`);
      expect(result.cached.bootstrap.cacheScope).toBe(`install-${i}`);
      expect(
        await page.evaluate(
          (text) => (window as any).fixture.retries.promptSubmissionId("1", "prompt", text, []),
          `install-${i}`,
        ),
      ).toBe(`receipt-install-${i}`);
    }
    await main.reload();
    await main.waitForFunction(() => Boolean((window as any).fixture));
    expect((await snapshot(main)).cached).toBeUndefined();
    await main.evaluate(() => (window as any).fixture.cache.registerMainCacheBootstrap());
    await seed(main, "new-login");
    expect((await snapshot(main)).cached.bootstrap.cacheScope).toBe("new-login");
    expect((await snapshot(safe)).cached.bootstrap.cacheScope).toBe("install-2");
  } finally {
    await context.close();
  }
});

test("Chromium keeps real app auth active when a different install logs out", async () => {
  const context = await browser.newContext();
  try {
    await context.route("**/api/bootstrap", async (route) => {
      await route.fulfill({
        json: {
          authenticated: true,
          cacheScope: new URL(route.request().url()).pathname,
          cacheExpiresAt: Date.now() + 60_000,
          settings: { appearance: { title: "Batty", color: "neutral" } },
          models: [],
          workspaces: [],
          auth: {},
          providerAuth: { providers: [] },
        },
      });
    });
    const main = await open(context, "/batty");
    const safe = await open(context, "/batty-safe");
    const same = await open(context, "/batty/");
    for (const page of [main, safe, same]) {
      await fixtureOperation(server, page, "session.get", async () => ({
        value: {
          id: "1",
          streamId: "test",
          revision: 1,
          messages: [],
          totalMessageCount: 0,
          activeTools: [],
          queuedPrompts: [],
        },
      }));
      await page.evaluate(() => (window as any).fixture.store.bootstrap());
      expect(await page.evaluate(() => (window as any).fixture.store.lastError)).toBeUndefined();
      expect(await page.evaluate(() => (window as any).fixture.store.authenticated)).toBe(true);
    }
    await main.evaluate(() => (window as any).fixture.cache.clearMainCache("signed-out"));
    await same.waitForFunction(() => !(window as any).fixture.store.authenticated);
    expect(await safe.evaluate(() => (window as any).fixture.store.authenticated)).toBe(true);
    expect(await safe.evaluate(() => (window as any).fixture.store.activeSession.id)).toBe("1");
  } finally {
    await context.close();
  }
});

test("one installation's write lock does not block another installation", async () => {
  const context = await browser.newContext();
  try {
    const main = await open(context, "/batty");
    const safe = await open(context, "/batty-safe");
    await main.evaluate(() => {
      const { installationStorageKey } = (window as any).fixture;
      void navigator.locks.request(
        installationStorageKey("main-reading-cache"),
        () =>
          new Promise<void>((resolve) => {
            (window as any).releaseLock = resolve;
          }),
      );
    });
    await main.waitForFunction(() => Boolean((window as any).releaseLock));
    await seed(safe, "unblocked");
    expect((await snapshot(safe)).cached.bootstrap.cacheScope).toBe("unblocked");
    await main.evaluate(() => (window as any).releaseLock());
  } finally {
    await context.close();
  }
});
