// @vitest-environment node
import path from "node:path";
import vue from "@vitejs/plugin-vue";
import { chromium, type Browser, type Page } from "patchright";
import type { ViteDevServer } from "vite";
import { closeBrowserFixtureServer, createBrowserFixtureServer } from "../test/browser-fixture";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

declare global {
  interface Window {
    __layoutReads: number;
    __cacheRestored: boolean;
  }
}

let server: ViteDevServer;
let browser: Browser;
let url: string;
beforeAll(async () => {
  server = await createBrowserFixtureServer(
    "src/client/components/SessionTranscript.fixture.html",
    {
      plugins: [
        vue(),
        {
          name: "reconnect-fixture",
          configureServer(server) {
            server.middlewares.use("/fixture-resumed.json", (_request, response) => {
              response.setHeader("content-type", "application/json");
              response.end(
                JSON.stringify({
                  streamId: "after-restart",
                  revision: 1,
                  totalMessageCount: 3,
                  isStreaming: false,
                  messages: [
                    {
                      id: "101",
                      role: "assistant",
                      timestamp: Date.now(),
                      runTaskId: "42",
                      stopReason: "aborted",
                      turnPhase: "final",
                      blocks: [{ type: "text", text: "**Jeg synes, tur" }],
                    },
                    {
                      id: "102",
                      role: "assistant",
                      timestamp: Date.now(),
                      runTaskId: "42",
                      stopReason: "stop",
                      turnPhase: "final",
                      blocks: [{ type: "text", text: "**Full reply after reconnect**" }],
                    },
                  ],
                }),
              );
            });
          },
        },
      ],
      resolve: { alias: { "@": path.resolve("src") } },
      server: { host: "127.0.0.1", port: 0 },
    },
  );
  await server.listen();
  url = `${server.resolvedUrls!.local[0]}src/client/components/SessionTranscript.fixture.html`;
  browser = await chromium.launch({ headless: true });
}, 30_000);
afterAll(async () => {
  await browser?.close();
  if (server) await closeBrowserFixtureServer(server);
});
async function state(page: Page, value: string) {
  await page.evaluate(
    (detail) => document.dispatchEvent(new CustomEvent("fixture-state", { detail })),
    value,
  );
}

for (const width of [390]) {
  test(`empty cron response never creates a bubble or Copy action at ${width}px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    try {
      await page.goto(url);
      await state(page, "empty-cron");
      await page.getByText("Google Docs Markdown", { exact: true }).waitFor();
      const copy = page.getByRole("button", { name: "Copy reply as markdown", exact: true });
      expect(await copy.count()).toBe(1);
      expect(await page.locator(".message__segment--bubble").count()).toBe(1);
      await page.getByRole("button", { name: "Show details", exact: true }).click();
      await page.getByText("Heartbeat result", { exact: true }).waitFor();
      await page.getByText("Research result", { exact: true }).waitFor();
      expect(await copy.count()).toBe(1);
      expect(await page.locator(".message__segment--bubble").count()).toBe(1);
      await state(page, "always");
      expect(await copy.count()).toBe(1);
      expect(await page.locator(".message__segment--bubble").count()).toBe(1);
    } finally {
      await page.close();
    }
  });
  test(`orphan details toggle without a reply bubble at ${width}px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    try {
      await page.goto(url);
      await state(page, "orphan");
      const toggle = page.getByRole("button", { name: "Show details", exact: true });
      await toggle.waitFor();
      expect(await page.locator(".message").count()).toBe(0);
      expect(await page.locator(".transcript button").count()).toBe(1);
      expect(await toggle.getAttribute("aria-expanded")).toBe("false");
      await toggle.focus();
      await page.keyboard.press("Enter");
      await page.getByText("Full cron result", { exact: true }).waitFor();
      await page.getByText("Cron artifact", { exact: true }).first().waitFor();
      await page.getByText("NO_REPLY", { exact: true }).waitFor();
      expect(await page.locator(".message__segment--bubble").count()).toBe(0);
      expect(
        await page.getByRole("button", { name: "Copy reply as markdown", exact: true }).count(),
      ).toBe(0);
      const collapse = page.getByRole("button", { name: "Collapse details", exact: true });
      expect(await collapse.getAttribute("aria-expanded")).toBe("true");
      expect(await collapse.evaluate((element) => element === document.activeElement)).toBe(true);
      await page.keyboard.press("Space");
      await page.getByText("Full cron result", { exact: true }).waitFor({ state: "hidden" });
      expect(await page.getByText("NO_REPLY", { exact: true }).count()).toBe(0);
      await state(page, "always");
      await page.getByText("NO_REPLY", { exact: true }).waitFor();
      expect(await page.locator(".message__segment--bubble").count()).toBe(0);
      expect(
        await page.getByRole("button", { name: "Copy reply as markdown", exact: true }).count(),
      ).toBe(0);
    } finally {
      await page.close();
    }
  });
  test(`silent image replies retain their details control at ${width}px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    try {
      await page.goto(url);
      await state(page, "silent-image");
      await page.getByRole("img", { name: "Silent image", exact: true }).waitFor();
      expect(await page.getByText("NO_REPLY", { exact: true }).count()).toBe(0);
      const toggle = page.getByRole("button", { name: "Show details", exact: true });
      await toggle.focus();
      await page.keyboard.press("Enter");
      await page.getByText("NO_REPLY", { exact: true }).waitFor();
      const collapse = page.getByRole("button", { name: "Collapse details", exact: true });
      expect(await collapse.evaluate((element) => element === document.activeElement)).toBe(true);
      expect(await page.locator(".message__segment--bubble").count()).toBe(1);
      await page.keyboard.press("Space");
      await page.getByText("NO_REPLY", { exact: true }).waitFor({ state: "hidden" });
      await toggle.waitFor();
    } finally {
      await page.close();
    }
  });
  test(`interrupted stream survives offline cache and reconnect delta at ${width}px`, async () => {
    const context = await browser.newContext({ viewport: { width, height: 800 } });
    const page = await context.newPage();
    page.setDefaultTimeout(3000);
    page.on("pageerror", (error) => console.error(error.message));
    try {
      await page.goto(url);
      await state(page, "partial");
      await page.getByText("**Jeg synes, tur", { exact: true }).waitFor();
      await context.setOffline(true);
      await state(page, "interrupted-cache");
      await page.getByText("Interrupted response", { exact: true }).waitFor();
      await expect
        .poll(() => page.evaluate(() => window.__cacheRestored, undefined, undefined, false))
        .toBe(true);
      await context.setOffline(false);
      await state(page, "reconnect");
      await page.getByText("Full reply after reconnect", { exact: true }).waitFor();
      await page.getByText("Interrupted response", { exact: true }).waitFor({ state: "hidden" });
      expect(await page.locator(".message--assistant").count()).toBe(1);
      await page.getByText("Fix spacing", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Show details", exact: true }).click();
      await page.getByText("Interrupted response", { exact: true }).waitFor();
      await page.getByText("**Jeg synes, tur", { exact: true }).waitFor();
      expect(await page.locator(".message--assistant").count()).toBe(2);
    } finally {
      await context.close();
    }
  });
  test(`image-heavy transcript stays bounded and idle streaming does not poll layout at ${width}px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    try {
      await page.goto(url);
      await state(page, "long");
      await page.getByText("Long message 1999", { exact: true }).waitFor();
      await page.waitForTimeout(300);
      expect(await page.locator(".message").count()).toBeLessThan(30);
      expect(await page.locator(".transcript__tail .message").count()).toBe(8);
      await page.evaluate(() => {
        const original = Element.prototype.getBoundingClientRect;
        window.__layoutReads = 0;
        Element.prototype.getBoundingClientRect = function () {
          if (
            this.classList.contains("transcript") ||
            this.classList.contains("transcript__bottom")
          )
            window.__layoutReads++;
          return original.call(this);
        };
      });
      await page.waitForTimeout(300);
      expect(await page.evaluate(() => window.__layoutReads)).toBe(0);
      const transcript = page.locator(".transcript");
      await transcript.hover();
      await page.mouse.wheel(0, -1200);
      await page.waitForTimeout(150);
      const anchor = await page.locator(".message__text").evaluateAll((elements) => {
        const visible = elements.find((element) => {
          const rect = element.getBoundingClientRect();
          return rect.top >= 0 && rect.top < 650;
        })!;
        return { text: visible.textContent!, top: visible.getBoundingClientRect().top };
      });
      await state(page, "append");
      await page.waitForTimeout(150);
      const after = await page.getByText(anchor.text, { exact: true }).boundingBox();
      expect(Math.abs(after!.y - anchor.top)).toBeLessThan(20);
      await page.getByRole("button", { name: "Jump to latest" }).click();
      await page.getByText("Fix spacing", { exact: true }).waitFor();
      await page.waitForTimeout(300);
      expect(
        await transcript.evaluate(
          (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
        ),
      ).toBeLessThan(14);
    } finally {
      await page.close();
    }
  });
  test(`runtime completion collapses automatic details but preserves manual expansion at ${width}px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    page.setDefaultTimeout(5_000);
    try {
      await page.goto(url);
      const details = page.getByText("Header spacing task details", { exact: true });
      await details.waitFor();
      expect(await page.locator(".details-button").count()).toBe(0);
      await state(page, "reply");
      await details.waitFor({ state: "hidden" });
      const toggle = page.getByRole("button", { name: "Show details", exact: true });
      await toggle.waitFor();
      await toggle.click();
      await details.waitFor();
      await state(page, "delivery");
      await page.getByText("Spacing worker completed", { exact: true }).waitFor();
      await details.waitFor();
      await state(page, "finished");
      await page.getByText("Spacing live", { exact: true }).waitFor();
      await page
        .getByText("Spacing worker completed", { exact: true })
        .waitFor({ state: "hidden" });
      await details.waitFor();
      await page.getByRole("button", { name: "Collapse details", exact: true }).click();
      await details.waitFor({ state: "hidden" });
      await page.getByRole("button", { name: "Show details", exact: true }).first().click();
      await details.waitFor();
      await state(page, "switch");
      await details.waitFor({ state: "hidden" });
      expect(
        await page.getByRole("button", { name: "Collapse details", exact: true }).count(),
      ).toBe(0);
      await state(page, "always");
      await details.waitFor();
      expect(await page.locator(".details-button").count()).toBe(0);
    } finally {
      await page.close();
    }
  });
}
