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

for (const { width, colorScheme } of [{ width: 390, colorScheme: "light" as const }]) {
  test(`queued runtime results at ${width}px (${colorScheme})`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme });
    try {
      await page.goto(url);
      await page.getByText("Ordinary follow-up", { exact: true }).waitFor();
      const notices = page.locator(".composer-queue__item--notice");
      expect(await notices.count()).toBe(2);
      for (const notice of await notices.all()) {
        expect(await notice.getByRole("button").count()).toBe(0);
        expect(await notice.textContent()).toContain("Meaningful report");
      }
      const text = await page.locator(".composer-queue").textContent();
      expect(text).not.toContain("batty-runtime-notice");
      expect(text).not.toContain("Internal routing");
      expect(text).not.toContain("private-session");
      expect(text).not.toContain("Private instructions");
      await page.getByRole("button", { name: "Remove queued prompt" }).click();
      await page.getByRole("button", { name: "Remove steering prompt" }).click();
      expect(await page.locator(".composer-queue__item").count()).toBe(2);
    } finally {
      await page.close();
    }
  }, 30_000);
}
