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
    "src/client/components/RuntimeNoticeArtifacts.fixture.html",
    {
      plugins: [vue()],
      resolve: { alias: { "@": path.resolve("src") } },
      server: { host: "127.0.0.1", port: 0 },
    },
  );
  await server.listen();
  url = `${server.resolvedUrls!.local[0]}src/client/components/RuntimeNoticeArtifacts.fixture.html`;
  browser = await chromium.launch({ headless: true });
}, 30_000);
afterAll(async () => {
  await browser?.close();
  if (server) await closeBrowserFixtureServer(server);
});
const themedLayouts = [{ width: 320, colorScheme: "light" as const }];

for (const { width, colorScheme } of themedLayouts) {
  test(`cron, subagent and ordinary reply artifacts render directly at ${width}px (${colorScheme})`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme });
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.getByText("Cabin attached.").first().waitFor();
      const messages = page.locator("article.message");
      expect(await messages.count()).toBe(3);
      for (const message of await messages.all()) {
        expect(await message.getByText("Cabin.jpg", { exact: true }).count()).toBe(1);
        expect(await message.locator(".shared-sites__meta strong").count()).toBe(1);
        const diff = message.getByRole("button", { name: "View changes" });
        await diff.click();
        const popover = page.locator(".agent-turn-diff-popover:popover-open");
        await popover.waitFor();
        await popover.locator(".agent-turn-diff-popover__viewer diffs-container").waitFor();
        await popover.getByRole("button", { name: "Close code changes" }).click();
      }
      expect(await page.getByRole("button", { name: "Open cron session" }).count()).toBe(1);
      expect(await page.getByRole("button", { name: "Open subagent session" }).count()).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);
}

for (const width of [320]) {
  const colorScheme = "light";
  test(`small popovers dismiss on Escape and outside click at ${width}px (${colorScheme})`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme });
    page.setDefaultTimeout(5000);
    await page.route("**/api/provider-usage?*", (route) =>
      route.fulfill({ status: 503, json: { error: "Fixture usage unavailable" } }),
    );
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      for (const { name, selector } of [
        { name: "Usage limits unavailable", selector: ".usage-details" },
        { name: "Running tasks", selector: ".tasks-popover" },
        { name: "Footer model", selector: "#fixture-footer-model" },
      ]) {
        const trigger = page.getByRole("button", { name, exact: true });
        await trigger.click();
        const popover = page.locator(`${selector}:popover-open`);
        await popover.waitFor();
        await page.keyboard.press("Escape");
        expect(await page.locator(`${selector}:popover-open`).count()).toBe(0);
        await trigger.click();
        await popover.waitFor();
        await page.mouse.click(width - 2, 450);
        expect(await page.locator(`${selector}:popover-open`).count()).toBe(0);
      }
    } finally {
      await page.close();
    }
  }, 30_000);
}

for (const { width, colorScheme } of themedLayouts) {
  test(`runtime notice popovers preserve nested navigation at ${width}px (${colorScheme})`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme });
    page.setDefaultTimeout(5000);
    await page.route("**/api/sessions/42", (route) =>
      route.fulfill({
        json: {
          id: "42",
          sessionId: "42",
          messages: [
            {
              id: "worker-reply",
              role: "assistant",
              timestamp: 1,
              turnPhase: "final",
              blocks: [{ type: "text", text: "Worker `inline code`" }],
            },
            {
              id: "nested-notice",
              role: "custom",
              timestamp: 2,
              customType: "batty-runtime-notice:subagent",
              text: "Nested worker",
              data: { subagent: { sessionId: "43" } },
            },
          ],
          activeTools: [],
          isStreaming: false,
        },
      }),
    );
    await page.route("**/api/sessions/43", (route) =>
      route.fulfill({
        json: { id: "43", sessionId: "43", messages: [], activeTools: [], isStreaming: false },
      }),
    );
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "Open subagent session", exact: true }).click();
      const parent = page.locator("#subagent-notice-popover-42");
      await parent.getByText("Worker inline code", { exact: true }).waitFor();
      await parent.getByRole("button", { name: "Open subagent session", exact: true }).click();
      const child = page.locator("#subagent-notice-popover-43");
      await child.locator(".transcript").waitFor();
      expect(await parent.evaluate((element) => element.matches(":popover-open"))).toBe(true);
      expect(await child.evaluate((element) => element.matches(":popover-open"))).toBe(true);
      await child.getByRole("button", { name: "Close subagent transcript" }).click();
      expect(await parent.evaluate((element) => element.matches(":popover-open"))).toBe(true);
      await parent.getByRole("button", { name: "Close subagent transcript" }).click();
    } finally {
      await page.close();
    }
  }, 30_000);
}
