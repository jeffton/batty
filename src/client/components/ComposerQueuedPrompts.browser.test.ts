// @vitest-environment node
import path from "node:path";
import vue from "@vitejs/plugin-vue";
import { chromium, type Browser } from "patchright";
import type { ViteDevServer } from "vite";
import { closeBrowserFixtureServer, createBrowserFixtureServer } from "../test/browser-fixture";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

let server: ViteDevServer;
let browser: Browser;
let url: string;

beforeAll(async () => {
  server = await createBrowserFixtureServer(
    "src/client/components/ComposerQueuedPrompts.fixture.html",
    {
      plugins: [vue()],
      resolve: { alias: { "@": path.resolve("src") } },
      server: { host: "127.0.0.1", port: 0 },
    },
  );
  await server.listen();
  url = `${server.resolvedUrls!.local[0]}src/client/components/ComposerQueuedPrompts.fixture.html`;
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  if (server) await closeBrowserFixtureServer(server);
});

for (const { width, colorScheme } of [
  { width: 390, colorScheme: "light" as const },
  { width: 1100, colorScheme: "light" as const },
  { width: 390, colorScheme: "dark" as const },
]) {
  test(`queued runtime results at ${width}px (${colorScheme})`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme });
    try {
      await page.goto(url);
      await page.getByText("Ordinary follow-up", { exact: true }).waitFor();
      const items = page.locator(".composer-queue__item");
      const heights = await items.evaluateAll((elements) =>
        elements.map((element) => element.getBoundingClientRect().height),
      );
      expect(heights).toHaveLength(4);
      for (const height of heights) {
        expect(height).toBe(heights[2]);
        expect(height).toBeGreaterThanOrEqual(44);
      }
      const notices = page.locator(".composer-queue__item--notice");
      expect(await notices.count()).toBe(2);
      expect(await notices.nth(0).locator("svg.lucide-list-ordered").count()).toBe(1);
      expect(await notices.nth(1).locator("svg.lucide-compass").count()).toBe(1);
      expect(await notices.locator("svg.lucide-bell").count()).toBe(0);
      for (const notice of await notices.all()) {
        expect(await notice.getByRole("button").count()).toBe(0);
        expect(await notice.textContent()).toContain("Meaningful report");
        expect(await notice.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
          await page.evaluate(() => {
            const sample = document.createElement("div");
            sample.style.background = "var(--color-info-soft)";
            document.body.append(sample);
            const color = getComputedStyle(sample).backgroundColor;
            sample.remove();
            return color;
          }),
        );
      }
      const text = await page.locator(".composer-queue").textContent();
      expect(text).not.toContain("batty-runtime-notice");
      expect(text).not.toContain("Internal routing");
      expect(text).not.toContain("private-session");
      expect(text).not.toContain("Private instructions");
      await page.getByRole("button", { name: "Remove queued prompt" }).click();
      await page.getByRole("button", { name: "Remove steering prompt" }).click();
      expect(await page.locator(".composer-queue__item").count()).toBe(2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    } finally {
      await page.close();
    }
  }, 30_000);
}
