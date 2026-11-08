// @vitest-environment node
import path from "node:path";
import vue from "@vitejs/plugin-vue";
import { chromium, type Browser } from "patchright";
import { type Page } from "playwright-core";
import { launchWebKit } from "../test/webkit";
import type { ViteDevServer } from "vite";
import { closeBrowserFixtureServer, createBrowserFixtureServer } from "../test/browser-fixture";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

let server: ViteDevServer;
let browser: Browser;
let webkitBrowser: Awaited<ReturnType<typeof launchWebKit>>;
let url: string;

beforeAll(async () => {
  server = await createBrowserFixtureServer("src/client/components/MessageComposer.fixture.html", {
    plugins: [vue()],
    define: { __BATTY_BUILD_ID__: JSON.stringify("dev") },
    resolve: { alias: { "@": path.resolve("src") } },
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  url = `${server.resolvedUrls!.local[0]}src/client/components/MessageComposer.fixture.html?tasks&memory`;
  browser = await chromium.launch({ headless: true });
  webkitBrowser = await launchWebKit();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await webkitBrowser?.close();
  if (server) await closeBrowserFixtureServer(server);
});

for (const width of [390, 1280]) {
  test.each(["Chromium", "WebKit"])(
    `%s memory warning keeps the tasks button size at ${width}px`,
    async (engine) => {
      const page = (await (engine === "Chromium" ? browser : webkitBrowser).newPage({
        viewport: { width, height: 800 },
      })) as Page;
      try {
        await page.goto(url);
        // Freeze rotation so bounding boxes measure layout rather than animation phase.
        await page.addStyleTag({ content: ".spinner { animation: none !important; }" });
        const button = page.getByRole("button", { name: "Running tasks", exact: true });
        await button.waitFor();
        await page.evaluate(() => document.fonts.ready);
        const before = (await button.boundingBox())!;
        const spinnerBefore = (await button.locator(".tasks-control__spinner").boundingBox())!;
        await page.screenshot({ path: `.tmp/tasks-${engine}-${width}-before.png` });
        await page.evaluate(() => window.dispatchEvent(new Event("fixture:memory-error")));
        const warning = button.locator('[aria-label="Memory error"]');
        await warning.waitFor();
        const after = (await button.boundingBox())!;
        expect(after.width).toBe(before.width);
        expect(after.height).toBe(before.height);
        const spinner = (await button.locator(".tasks-control__spinner").boundingBox())!;
        expect(spinner).toEqual(spinnerBefore);
        const icon = (await warning.boundingBox())!;
        expect(icon.width).toBeCloseTo(spinner.width);
        expect(icon.height).toBeCloseTo(spinner.height);
        expect(icon.x).toBeGreaterThan(spinner.x + spinner.width);
        const label = (await button.locator("strong").boundingBox())!;
        expect(icon.y).toBeGreaterThanOrEqual(label.y + label.height);
        expect(icon.y + icon.height).toBeLessThanOrEqual(after.y + after.height);
        expect(icon.x + icon.width).toBeLessThanOrEqual(after.x + after.width);
        await page.screenshot({ path: `.tmp/tasks-${engine}-${width}-warning.png` });
        await button.click();
        expect(await page.getByRole("alert").textContent()).toBe("Error: WebSocket closed 1000");

        await page.goto(url.replace("?tasks&memory", "?memory"));
        await page.addStyleTag({ content: ".spinner { animation: none !important; }" });
        await button.waitFor();
        await page.evaluate(() => document.fonts.ready);
        const single = (await button.boundingBox())!;
        await page.evaluate(() => {
          window.dispatchEvent(new Event("fixture:memory-error"));
          window.dispatchEvent(new Event("fixture:finish-memory"));
        });
        await warning.waitFor();
        expect(await button.locator(".tasks-control__spinner").count()).toBe(0);
        const warningOnly = (await button.boundingBox())!;
        expect(warningOnly.width).toBe(single.width);
        expect(warningOnly.height).toBe(single.height);
        await page.screenshot({ path: `.tmp/tasks-${engine}-${width}-warning-only.png` });
      } finally {
        await page.close();
      }
    },
  );
}
