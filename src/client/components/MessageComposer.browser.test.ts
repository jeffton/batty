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
  server = await createBrowserFixtureServer("src/client/components/MessageComposer.fixture.html", {
    plugins: [vue()],
    define: { __BATTY_BUILD_ID__: JSON.stringify("dev") },
    resolve: { alias: { "@": path.resolve("src") } },
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  url = `${server.resolvedUrls!.local[0]}src/client/components/MessageComposer.fixture.html`;
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  if (server) await closeBrowserFixtureServer(server);
});

for (const width of [320, 1100]) {
  test(`composer controls stay separated at ${width}px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    try {
      for (const query of ["", "?streaming", "?tasks", "?streaming&tasks"]) {
        await page.goto(url + query);
        await page.getByRole("button", { name: "Send prompt" }).waitFor();
        const controls = await page.locator(".composer__actions-row").evaluate((row) =>
          [...row.children]
            .filter((element) => element.getBoundingClientRect().width > 0)
            .map((element) => {
              const rect = element.getBoundingClientRect();
              return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
            }),
        );
        const gaps = controls
          .slice(1)
          .map((control, index) => control.left - controls[index]!.right);
        expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(1);
        for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(24);
        for (const control of controls) {
          expect(control.left).toBeGreaterThanOrEqual(0);
          expect(control.right).toBeLessThanOrEqual(width);
        }
        const buttons = await page
          .locator(".composer__actions-row button")
          .evaluateAll((elements) =>
            elements.map((element) => {
              const rect = element.getBoundingClientRect();
              return { width: rect.width, height: rect.height };
            }),
          );
        for (const button of buttons) {
          expect(button.width).toBeGreaterThanOrEqual(44);
          expect(button.height).toBeGreaterThanOrEqual(44);
        }
        if (query.includes("streaming")) {
          const stop = await page.getByRole("button", { name: "Stop", exact: true }).boundingBox();
          const send = await page.getByRole("button", { name: "Send prompt" }).boundingBox();
          expect(send!.x - (stop!.x + stop!.width)).toBeGreaterThanOrEqual(24);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        if (query === "?streaming&tasks") {
          const positions = async () =>
            Promise.all(
              ["Add files", "Stop", "Send prompt"].map((name) =>
                page.getByRole("button", { name, exact: true }).boundingBox(),
              ),
            );
          const before = await positions();
          const tasks = await page
            .getByRole("button", { name: "Running tasks", exact: true })
            .boundingBox();
          await page.evaluate(() => window.dispatchEvent(new Event("fixture:finish-agent")));
          await page
            .getByRole("button", { name: "Running tasks", exact: true })
            .waitFor({ state: "detached" });
          expect(await positions()).toEqual(before);
          const stop = await page.getByRole("button", { name: "Stop", exact: true }).boundingBox();
          expect(stop!.x).toBeGreaterThanOrEqual(tasks!.x + tasks!.width);
          await page.evaluate(() => window.dispatchEvent(new Event("fixture:finish-main")));
          await page
            .getByRole("button", { name: "Stop", exact: true })
            .waitFor({ state: "detached" });
          expect(await page.getByRole("button", { name: "Add files" }).boundingBox()).toEqual(
            before[0],
          );
          expect(await page.getByRole("button", { name: "Send prompt" }).boundingBox()).toEqual(
            before[2],
          );
        }
      }
    } finally {
      await page.close();
    }
  }, 30_000);
}
