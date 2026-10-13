// @vitest-environment node
import path from "node:path";
import vue from "@vitejs/plugin-vue";
import { chromium, type Browser, type Locator } from "patchright";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { closeBrowserFixtureServer, createBrowserFixtureServer } from "../test/browser-fixture";

let server: ViteDevServer;
let browser: Browser;
let url: string;
beforeAll(async () => {
  server = await createBrowserFixtureServer("src/client/components/SessionRows.fixture.html", {
    plugins: [vue()],
    define: { __BATTY_BUILD_ID__: JSON.stringify("dev") },
    resolve: { alias: { "@": path.resolve("src") } },
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  url = `${server.resolvedUrls!.local[0]}src/client/components/SessionRows.fixture.html`;
  browser = await chromium.launch({ headless: true });
}, 30_000);
afterAll(async () => {
  await browser?.close();
  if (server) await closeBrowserFixtureServer(server);
});

async function expectContainedRows(rows: Locator, contentSelector: string) {
  const layout = await rows.evaluateAll(
    (elements, selector) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        const content = element.querySelector(selector)!.getBoundingClientRect();
        return {
          top: rect.top,
          bottom: rect.bottom,
          height: rect.height,
          contentTop: content.top,
          contentBottom: content.bottom,
          overflow: element.scrollWidth > element.clientWidth,
          weight: getComputedStyle(element).fontWeight,
          isButton: element.tagName === "BUTTON",
        };
      }),
    contentSelector,
  );
  for (const [index, row] of layout.entries()) {
    expect(row.height).toBeGreaterThanOrEqual(44);
    if (row.isButton) expect(row.weight).toBe("700");
    expect(row.contentTop).toBeGreaterThanOrEqual(row.top);
    expect(row.contentBottom).toBeLessThanOrEqual(row.bottom);
    expect(row.overflow).toBe(false);
    if (index) expect(row.top).toBeGreaterThanOrEqual(layout[index - 1]!.bottom);
  }
}

for (const width of [320, 390, 1100]) {
  test(`cron session rows contain wrapped metadata and errors at ${width}px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    try {
      await page.route("**/api/**", async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        const logs = Array.from({ length: 4 }, (_, index) => ({
          runId: `run-${index}`,
          sessionId: `cron-${index}`,
          workspaceId: "fixture",
          prompt: "Read the workflow, check its inputs, and publish the resulting report",
          scheduleLabel: "*/15 9-21 * * * (Europe/Stockholm)",
          startedAtMs: 1_791_918_000_000 - index * 900_000,
          durationMs: 87_000,
          status: index === 1 ? "failed" : "success",
          ...(index === 1
            ? {
                error:
                  "The provider could not complete this request because the connection was interrupted during processing.",
              }
            : {}),
        }));
        await route.fulfill({
          json: pathname.endsWith("/cron-run-logs")
            ? logs
            : pathname.endsWith("/cron-jobs")
              ? []
              : {},
        });
      });
      await page.goto(url);
      await page.getByRole("button", { name: "Cron", exact: true }).click();
      await page.getByRole("tab", { name: "Logs", exact: true }).click();
      const rows = page.locator("#cron-logs-panel .cron-popover__run");
      await rows.nth(3).waitFor();
      await page.screenshot({
        path: `/tmp/session-rows-cron-${process.env.BATTY_LAYOUT_CAPTURE ?? "after"}-${width}.png`,
      });
      await expectContainedRows(rows, ".cron-popover__run-content");
      const details = await rows.first().locator(".cron-popover__run-details").boundingBox();
      if (width < 400) expect(details!.height).toBeGreaterThan(30);
      expect(await rows.first().locator("button").count()).toBe(0);
      expect(await rows.first().locator("svg").getAttribute("aria-hidden")).toBe("true");
      await rows.first().focus();
      await page.keyboard.press("Enter");
      await expect
        .poll(() =>
          page.locator("#cron-cron-run-0").evaluate((element) => element.matches(":popover-open")),
        )
        .toBe(true);
    } finally {
      await page.close();
    }
  });

  test(`task session rows retain content height and row activation at ${width}px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    try {
      await page.route("**/api/**", (route) => route.fulfill({ json: {} }));
      await page.goto(url);
      expect(
        await page
          .getByRole("link", { name: "Ordinary link" })
          .evaluate((element) => getComputedStyle(element).fontWeight),
      ).toBe("400");
      await page.getByRole("button", { name: "Running tasks" }).click();
      const rows = page.locator(".tasks-popover:popover-open .tasks-popover__task");
      await rows.nth(2).waitFor();
      await page.screenshot({
        path: `/tmp/session-rows-tasks-${process.env.BATTY_LAYOUT_CAPTURE ?? "after"}-${width}.png`,
      });
      await expectContainedRows(rows, ".tasks-popover__details");
      const row = rows.nth(1);
      expect(await row.locator("button").count()).toBe(0);
      expect(await row.locator("svg").getAttribute("aria-hidden")).toBe("true");
      const target = await row.getAttribute("popovertarget");
      await row.locator("strong").click();
      await expect
        .poll(() =>
          page.locator(`[id="${target}"]`).evaluate((element) => element.matches(":popover-open")),
        )
        .toBe(true);
    } finally {
      await page.close();
    }
  });
}
