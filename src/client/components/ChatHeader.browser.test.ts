// @vitest-environment node
import path from "node:path";
import fs from "node:fs/promises";
import vue from "@vitejs/plugin-vue";
import { chromium, webkit, type Browser } from "playwright-core";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { closeBrowserFixtureServer, createBrowserFixtureServer } from "../test/browser-fixture";

let server: ViteDevServer;
let url: string;
beforeAll(async () => {
  server = await createBrowserFixtureServer("src/client/components/SettingsPopover.fixture.html", {
    plugins: [vue()],
    define: { __BATTY_BUILD_ID__: JSON.stringify("dev") },
    resolve: { alias: { "@": path.resolve("src") } },
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  url = `${server.resolvedUrls!.local[0]}src/client/components/SettingsPopover.fixture.html?shell`;
}, 30_000);
afterAll(async () => {
  if (server) await closeBrowserFixtureServer(server);
});

for (const engine of [chromium, webkit]) {
  test(`${engine.name()} keeps the original SDR logo and Settings interaction in both themes`, async () => {
    const browser: Browser = await engine.launch({ headless: true });
    try {
      for (const colorScheme of ["light", "dark"] as const) {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme });
        try {
          await page.route("**/api/**", (route) => route.fulfill({ json: { names: [] } }));
          await page.goto(url);
          await page.evaluate(() => {
            for (const popover of document.querySelectorAll<HTMLElement>(":popover-open"))
              popover.hidePopover();
          });
          const logo = page.locator(".header__brand img");
          await expect
            .poll(() =>
              logo.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth),
            )
            .toBe(64);
          expect(await logo.getAttribute("src")).toBe("/favicon.png");
          const style = await logo.evaluate((image) => ({
            content: getComputedStyle(image).content,
            width: getComputedStyle(image).width,
            height: getComputedStyle(image).height,
            hdr: matchMedia("(dynamic-range: high)").matches,
          }));
          expect(style.hdr).toBe(false);
          expect(style.content).toBe("normal");
          expect(style.width).toBe(style.height);
          if (process.env.BATTY_UI_SCREENSHOTS === "1") {
            await fs.mkdir(".tmp/hdr-logo", { recursive: true });
            await page.screenshot({ path: `.tmp/hdr-logo/${engine.name()}-${colorScheme}.png` });
          }
          // The host is SDR. Enable only this media rule to exercise CSS image
          // replacement and PNG decoding, not to claim physical HDR output.
          const replacement = await page.evaluate(async () => {
            function enableHdr(rules: CSSRuleList) {
              for (const rule of rules) {
                if (rule instanceof CSSStyleRule && rule.style.content.includes("logo-hdr.png")) {
                  const style = document.createElement("style");
                  style.textContent = rule.cssText;
                  document.head.append(style);
                }
                if ("cssRules" in rule) enableHdr((rule as CSSGroupingRule).cssRules);
              }
            }
            for (const sheet of [...document.styleSheets]) enableHdr(sheet.cssRules);
            const image = document.querySelector<HTMLImageElement>(".header__brand img")!;
            const content = getComputedStyle(image).content;
            const decoder = new Image();
            decoder.src = content.slice(5, -2);
            await decoder.decode();
            return {
              content,
              width: decoder.naturalWidth,
              height: decoder.naturalHeight,
              box: image.getBoundingClientRect().toJSON(),
            };
          });
          expect(replacement.content).toContain("logo-hdr.png");
          expect([replacement.width, replacement.height]).toEqual([64, 64]);
          expect(replacement.box.width).toBe(parseFloat(style.width));
          expect(replacement.box.height).toBe(parseFloat(style.height));
          if (process.env.BATTY_UI_SCREENSHOTS === "1") {
            await page.screenshot({
              path: `.tmp/hdr-logo/${engine.name()}-${colorScheme}-hdr-decoded.png`,
            });
          }
          await page.getByRole("button", { name: "Settings", exact: true }).click();
          expect(
            await page
              .locator("#settings-popover")
              .evaluate((element) => element.matches(":popover-open")),
          ).toBe(true);
        } finally {
          await page.close();
        }
      }
    } finally {
      await browser.close();
    }
  });
}
