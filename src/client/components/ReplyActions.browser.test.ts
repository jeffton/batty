// @vitest-environment node
import path from "node:path";
import vue from "@vitejs/plugin-vue";
import { chromium, type Browser, type Page } from "patchright";
import type { ViteDevServer } from "vite";
import { closeBrowserFixtureServer, createBrowserFixtureServer } from "../test/browser-fixture";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

let server: ViteDevServer;
let browser: Browser;
let url: string;

beforeAll(async () => {
  server = await createBrowserFixtureServer("src/client/components/ReplyActions.fixture.html", {
    plugins: [vue()],
    resolve: { alias: { "@": path.resolve("src") } },
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  url = `${server.resolvedUrls!.local[0]}src/client/components/ReplyActions.fixture.html`;
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  if (server) await closeBrowserFixtureServer(server);
});

async function verifyTargets(page: Page) {
  const buttons = page.locator(".reply-actions button");
  const copy = await buttons.nth(0).boundingBox();
  const details = await buttons.nth(1).boundingBox();
  expect(copy).toMatchObject({ width: 44, height: 44 });
  expect(details).toMatchObject({ width: 44, height: 44 });
  expect(copy!.y).toBe(details!.y);
  expect(copy!.x + copy!.width).toBe(details!.x);
  for (const button of [buttons.nth(0), buttons.nth(1)]) {
    const rect = (await button.boundingBox())!;
    // Cross both the icon and its padding, including the area occupied by
    // the following markdown block's box. Do not force pointer actions.
    for (const [dx, dy] of [
      [2, 2],
      [22, 22],
      [42, 22],
      [22, 42],
    ]) {
      await page.mouse.move(rect.x + dx!, rect.y + dy!);
      expect(
        await button.evaluate(
          (element, point) => {
            const hit = document.elementFromPoint(point.x, point.y);
            return element === hit || element.contains(hit);
          },
          { x: rect.x + dx!, y: rect.y + dy! },
        ),
      ).toBe(true);
      expect(await button.evaluate((element) => element.matches(":hover"))).toBe(true);
      expect(
        await button.evaluate((element) => getComputedStyle(element).backgroundColor),
      ).not.toBe("rgba(0, 0, 0, 0)");
    }
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(
    await page.evaluate(() => {
      const controls = [...document.querySelectorAll(".reply-actions button")].map((element) =>
        element.getBoundingClientRect(),
      );
      const walker = document.createTreeWalker(
        document.querySelector(".markdown-body")!,
        NodeFilter.SHOW_TEXT,
      );
      while (walker.nextNode()) {
        const range = document.createRange();
        range.selectNodeContents(walker.currentNode);
        for (const rect of range.getClientRects()) {
          if (
            controls.some(
              (control) =>
                rect.left < control.right &&
                rect.right > control.left &&
                rect.top < control.bottom &&
                rect.bottom > control.top,
            )
          )
            return false;
        }
      }
      return true;
    }),
  ).toBe(true);
}

for (const width of [1100, 375, 320]) {
  test(`reply actions remain reachable and compact at ${width}px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    page.setDefaultTimeout(5_000);
    page.on("pageerror", (error) => console.error(error));
    try {
      await page.goto(url);
      await page.locator(".details-button").waitFor();
      for (const location of ["tail", "history"]) {
        await page.evaluate((target) => {
          document.dispatchEvent(
            new CustomEvent("fixture-reply", {
              detail: { text: "Short answer", location: target },
            }),
          );
        }, location);
        const details = page.getByRole("button", { name: "Show details", exact: true });
        await details.waitFor();
        await verifyTargets(page);
        expect(
          (await page.locator(".message__segment--bubble").boundingBox())!.height,
        ).toBeLessThan(65);
        await details.click();
        await page.getByRole("button", { name: "Collapse details" }).waitFor();
        await verifyTargets(page);
        expect(await page.locator(".lucide-chevron-down").count()).toBe(1);
        await page.getByRole("button", { name: "Collapse details" }).click();
        await details.waitFor();
        expect(await page.locator(".lucide-chevron-up").count()).toBe(1);
      }
      await page.evaluate(() => {
        document.dispatchEvent(new CustomEvent("fixture-working", { detail: true }));
      });
      await page.locator(".details-button").waitFor({ state: "detached" });
      expect(await page.getByText("Work details", { exact: true }).count()).toBe(1);
      await page.evaluate(() => {
        document.dispatchEvent(new CustomEvent("fixture-working", { detail: false }));
      });
      await page.getByRole("button", { name: "Show details", exact: true }).waitFor();
      expect(await page.getByText("Work details", { exact: true }).count()).toBe(0);
      for (const location of ["tail", "history"]) {
        await page.evaluate((target) => {
          document.dispatchEvent(
            new CustomEvent("fixture-reply", {
              detail: {
                location: target,
                text: `[https://example.com/${"long-unbroken-label".repeat(8)}](https://example.com) and a longer answer that wraps around the action row. `.repeat(
                  4,
                ),
              },
            }),
          );
        }, location);
        const link = page.locator(".markdown-body a").first();
        await link.waitFor();
        await verifyTargets(page);
        await link.hover();
        expect(await link.evaluate((element) => element.matches(":hover"))).toBe(true);
      }
    } finally {
      await page.close();
    }
  }, 30_000);
}

test("touch layout keeps both actions on one row and supports tapping details", async () => {
  const page = await browser.newPage({
    viewport: { width: 375, height: 800 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    await page.goto(url);
    const details = page.getByRole("button", { name: "Show details", exact: true });
    await details.waitFor();
    expect(await page.evaluate(() => matchMedia("(hover: hover)").matches)).toBe(false);
    const copyRect = (await page
      .getByRole("button", { name: "Copy reply as markdown" })
      .boundingBox())!;
    const detailsRect = (await details.boundingBox())!;
    expect(copyRect).toMatchObject({ width: 44, height: 44, y: detailsRect.y });
    expect(detailsRect).toMatchObject({ width: 44, height: 44, x: copyRect.x + 44 });
    await details.tap();
    await page.getByRole("button", { name: "Collapse details" }).waitFor();
    await page.getByRole("button", { name: "Collapse details" }).tap();
    await details.waitFor();
    expect((await page.locator(".message__segment--bubble").boundingBox())!.height).toBeLessThan(
      65,
    );
  } finally {
    await page.close();
  }
}, 30_000);
