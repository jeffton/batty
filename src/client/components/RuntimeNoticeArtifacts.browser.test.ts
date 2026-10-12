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
const themedLayouts = [
  { width: 320, colorScheme: "light" as const },
  { width: 1100, colorScheme: "light" as const },
  { width: 390, colorScheme: "dark" as const },
];

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
        const codeBackground = await message
          .locator(".markdown-body code")
          .evaluate((element) => getComputedStyle(element).backgroundColor);
        const actions = message.locator(".message__diff-button, .message__notice-btn");
        for (const action of await actions.all()) {
          const styles = await action.evaluate((element) => {
            const style = getComputedStyle(element);
            return { background: style.backgroundColor, color: style.color };
          });
          expect(styles.background).toBe(codeBackground);
          expect(styles.color).toBe(
            await diff.evaluate((element) => getComputedStyle(element).color),
          );
          const actionBox = (await action.boundingBox())!;
          expect(actionBox.width).toBeGreaterThanOrEqual(44);
          expect(actionBox.height).toBeGreaterThanOrEqual(44);
          await page.keyboard.press("Tab");
          await action.focus();
          expect(await action.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe(
            "solid",
          );
          await action.hover();
          await expect
            .poll(() => action.evaluate((element) => getComputedStyle(element).backgroundColor))
            .not.toBe(codeBackground);
          await page.mouse.move(0, 0);
        }
        const box = (await diff.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
        await diff.click();
        const popover = page.locator(".agent-turn-diff-popover:popover-open");
        await popover.waitFor();
        const layout = await popover.evaluate((element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return {
            display: style.display,
            borderWidth: style.borderWidth,
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            width: rect.width,
          };
        });
        expect(layout, JSON.stringify(layout)).toMatchObject({
          display: "grid",
          borderWidth: "1px",
        });
        const inset = await page.evaluate(() =>
          Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
        );
        expect(layout.left).toBe(inset);
        expect(layout.top).toBe(inset);
        expect(layout.right).toBe(width - inset);
        expect(layout.bottom).toBe(900 - inset);
        expect(layout.width).toBe(width - 2 * inset);
        await popover.locator(".agent-turn-diff-popover__viewer diffs-container").waitFor();
        await popover.getByRole("button", { name: "Close code changes" }).click();
      }
      expect(await page.getByRole("button", { name: "Open cron session" }).count()).toBe(1);
      expect(await page.getByRole("button", { name: "Open subagent session" }).count()).toBe(1);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);
}

// Placement and dismissal depend on viewport size, not the color scheme.
for (const width of [320, 1100]) {
  const colorScheme = "light";
  test(`teleported model, usage and delete popovers retain their layout at ${width}px (${colorScheme})`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme });
    page.setDefaultTimeout(5000);
    await page.route("**/api/provider-usage?*", (route) =>
      route.fulfill({ status: 503, json: { error: "Fixture usage unavailable" } }),
    );
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      for (const { name, selector } of [
        { name: "Delete fixture", selector: ".delete-confirmation" },
        { name: "Choose model", selector: ".mc-popover" },
        { name: "Usage limits unavailable", selector: ".usage-details" },
      ]) {
        await page.getByRole("button", { name, exact: true }).click();
        const popover = page.locator(`${selector}:popover-open`);
        await popover.waitFor();
        expect(await popover.evaluate((element) => element.parentElement === document.body)).toBe(
          true,
        );
        const style = await popover.evaluate((element) => {
          const computed = getComputedStyle(element);
          return { display: computed.display, borderWidth: computed.borderWidth };
        });
        expect(style).toEqual({ display: "flex", borderWidth: "1px" });
        const box = (await popover.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        expect(box.y + box.height).toBeLessThanOrEqual(900);
        await page.keyboard.press("Escape");
      }
    } finally {
      await page.close();
    }
  }, 30_000);

  test(`small popovers have shadows without backdrops and dismiss normally at ${width}px (${colorScheme})`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme });
    page.setDefaultTimeout(5000);
    await page.route("**/api/provider-usage?*", (route) =>
      route.fulfill({ status: 503, json: { error: "Fixture usage unavailable" } }),
    );
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      for (const { name, selector, rightAligned } of [
        { name: "Usage limits unavailable", selector: ".usage-details", rightAligned: true },
        { name: "Running tasks", selector: ".tasks-popover", rightAligned: false },
        { name: "Footer model", selector: "#fixture-footer-model", rightAligned: true },
      ]) {
        const trigger = page.getByRole("button", { name, exact: true });
        const triggerBox = (await trigger.boundingBox())!;
        expect(triggerBox.width).toBeGreaterThanOrEqual(44);
        expect(triggerBox.height).toBeGreaterThanOrEqual(44);
        await trigger.click();
        const popover = page.locator(`${selector}:popover-open`);
        await popover.waitFor();
        if (rightAligned) {
          await expect
            .poll(async () => {
              const box = (await popover.boundingBox())!;
              return Math.round(box.x + box.width);
            })
            .toBe(width - 8);
        }
        const styles = await popover.evaluate((element) => ({
          shadow: getComputedStyle(element).boxShadow,
          backdrop: getComputedStyle(element, "::backdrop").backgroundColor,
        }));
        expect(styles.shadow).not.toBe("none");
        expect(styles.backdrop).toBe("rgba(0, 0, 0, 0)");
        for (const button of await popover.locator("button").all()) {
          const box = (await button.boundingBox())!;
          expect(box.width).toBeGreaterThanOrEqual(44);
          expect(box.height).toBeGreaterThanOrEqual(44);
        }
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
  test(`runtime notice popovers isolate styles and preserve nested navigation at ${width}px (${colorScheme})`, async () => {
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
      const normalCode = page.locator(".message--assistant .markdown-body code").first();
      const normalBackground = await normalCode.evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      );
      const noticeBackground = await page
        .locator(".message__runtime-markdown code")
        .first()
        .evaluate((element) => getComputedStyle(element).backgroundColor);
      expect(noticeBackground).not.toBe(normalBackground);
      await page.getByRole("button", { name: "Open subagent session", exact: true }).click();
      const parent = page.locator("#subagent-notice-popover-42");
      await parent.getByText("Worker inline code", { exact: true }).waitFor();
      expect(
        await parent
          .locator(".markdown-body code")
          .evaluate((element) => getComputedStyle(element).backgroundColor),
      ).toBe(normalBackground);
      expect(await parent.evaluate((element) => element.parentElement === document.body)).toBe(
        true,
      );
      await parent.getByRole("button", { name: "Open subagent session", exact: true }).click();
      const child = page.locator("#subagent-notice-popover-43");
      await child.locator(".transcript").waitFor();
      const inset = await page.evaluate(() =>
        Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
      );
      for (const popover of [parent, child]) {
        const box = (await popover.boundingBox())!;
        expect(box.x).toBe(inset);
        expect(box.width).toBe(width - 2 * inset);
        expect(box.y).toBeGreaterThanOrEqual(inset);
        expect(box.y + box.height).toBe(900 - inset);
        expect(await popover.evaluate((element) => getComputedStyle(element).display)).toBe("grid");
      }
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
