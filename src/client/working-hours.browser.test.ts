// @vitest-environment node
import path from "node:path";
import vue from "@vitejs/plugin-vue";
import { chromium, type Browser } from "playwright-core";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { closeBrowserFixtureServer, createBrowserFixtureServer } from "./test/browser-fixture";

let server: ViteDevServer;
let browser: Browser;
let url: string;
beforeAll(async () => {
  server = await createBrowserFixtureServer("index.html", {
    plugins: [vue()],
    define: { __BATTY_BUILD_ID__: JSON.stringify("dev") },
    resolve: { alias: { "@": path.resolve("src") } },
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  url = server.resolvedUrls!.local[0]!;
  browser = await chromium.launch({ headless: true });
}, 30_000);
afterAll(async () => {
  await browser?.close();
  if (server) await closeBrowserFixtureServer(server);
});

for (const [name, viewport] of [
  ["desktop", { width: 1100, height: 700 }],
  ["mobile", { width: 390, height: 700 }],
] as const) {
  test(`real ${name} app hides startup, supports temporary override, and rechecks after reload/resume`, async () => {
    const context = await browser.newContext({
      viewport,
      isMobile: name === "mobile",
      hasTouch: name === "mobile",
    });
    const page = await context.newPage();
    try {
      await page.clock.install({ time: new Date("2026-11-16T19:00:00Z") });
      let finish!: () => void;
      const delayed = new Promise<void>((resolve) => {
        finish = resolve;
      });
      await page.route("**/api/bootstrap", async (route) => {
        await delayed;
        await route.fulfill({
          json: {
            authenticated: false,
            auth: {
              passkeyCount: 0,
              passkeyLoginAvailable: false,
              registrationOpen: false,
              setupRequired: false,
            },
            providerAuth: { providers: [] },
            models: [],
            workspaces: [],
            settings: {
              braveSearchConfigured: false,
              appearance: { title: "Batty", color: "#172128" },
              workingHours: {
                timeZone: "Europe/Stockholm",
                days: [1, 2, 3, 4, 5],
                start: "09:00",
                end: "17:00",
              },
            },
          },
        });
      });
      await page.addInitScript(() => {
        (window as any).routedUiSeen = false;
        new MutationObserver(() => {
          if (document.querySelector(".login-view, .chat-view"))
            (window as any).routedUiSeen = true;
        }).observe(document, { childList: true, subtree: true });
      });
      await page.goto(url);
      await page.getByRole("status", { name: "Booting Batty" }).locator(".spinner").waitFor();
      expect(await page.locator(".login-view").count()).toBe(0);
      finish();
      await page.getByRole("heading", { name: "Off the clock." }).waitFor();
      expect(await page.evaluate(() => (window as any).routedUiSeen)).toBe(false);
      expect(await page.getByRole("button").count()).toBe(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      const logo = page.locator(".working-hours-logo");
      await logo.evaluate((image: HTMLImageElement) => image.decode());
      expect(await logo.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(512);
      await page.screenshot({ path: `/var/tmp/batty-working-hours-${name}.png` });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.screenshot({ path: `/var/tmp/batty-working-hours-${name}-dark.png` });
      if (name === "desktop") {
        await page.getByRole("button", { name: "Open anyway" }).hover();
        await page.screenshot({ path: "/var/tmp/batty-working-hours-desktop-dark-hover.png" });
      }
      await page.getByRole("button", { name: "Open anyway" }).click();
      await page.getByRole("button", { name: "Sign in with passkey" }).waitFor();
      await page.reload();
      await page.getByRole("heading", { name: "Off the clock." }).waitFor();
      expect(await page.locator(".login-view").count()).toBe(0);
      await page.getByRole("button", { name: "Open anyway" }).click();
      await page.getByRole("button", { name: "Sign in with passkey" }).waitFor();
      await page.clock.setSystemTime(new Date("2026-11-16T23:00:00Z"));
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await page.getByRole("heading", { name: "Off the clock." }).waitFor();
      await page.clock.setSystemTime(new Date("2026-11-17T08:00:00Z"));
      await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
      await page.getByRole("button", { name: "Sign in with passkey" }).waitFor();
      await page.clock.setSystemTime(new Date("2026-11-17T15:59:59Z"));
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await page.clock.runFor(1000);
      await page.getByRole("heading", { name: "Off the clock." }).waitFor();
      expect(await page.locator(".login-view").count()).toBe(0);
    } finally {
      await context.close();
    }
  });
}
