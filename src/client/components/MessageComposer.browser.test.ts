// @vitest-environment node
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { registerDraftRoutes } from "../../server/routes/drafts";
import { APP_COLOR_OPTIONS } from "../../shared/appearance";
import vue from "@vitejs/plugin-vue";
import { chromium, type Browser } from "patchright";
import { type Page } from "playwright-core";
import type { ViteDevServer } from "vite";
import { closeBrowserFixtureServer, createBrowserFixtureServer } from "../test/browser-fixture";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

let server: ViteDevServer;
let browser: Browser;
let url: string;
let draftRoot: string;
let api: FastifyInstance;

beforeAll(async () => {
  draftRoot = await fs.mkdtemp(path.join(os.tmpdir(), "batty-drafts-browser-"));
  api = Fastify();
  await api.register(multipart);
  await registerDraftRoutes(api, draftRoot);
  const draftApi = await api.listen({ host: "127.0.0.1", port: 0 });
  server = await createBrowserFixtureServer("src/client/components/MessageComposer.fixture.html", {
    plugins: [vue()],
    define: { __BATTY_BUILD_ID__: JSON.stringify("dev") },
    resolve: { alias: { "@": path.resolve("src") } },
    server: { host: "127.0.0.1", port: 0, proxy: { "/api/drafts": draftApi } },
  });
  await server.listen();
  url = `${server.resolvedUrls!.local[0]}src/client/components/MessageComposer.fixture.html`;
  browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ["--hide-scrollbars"] });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  if (server) await closeBrowserFixtureServer(server);
  await api?.close();
  if (draftRoot) await fs.rm(draftRoot, { recursive: true, force: true });
});

test("dark composer count labels stay readable on tinted toolbar backgrounds", async () => {
  const page = (await browser.newPage({ colorScheme: "dark", reducedMotion: "reduce" })) as Page;
  try {
    await page.goto(`${url}?drafts&tasks&streaming`);
    const buttons = [
      page.getByRole("button", { name: "Running tasks" }),
      page.getByRole("button", { name: /^Drafts:/ }),
    ];
    const contrast = (button: (typeof buttons)[number]) =>
      button.evaluate((element) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d", { willReadFrequently: true })!;
        const paint = (color: string) => {
          context.fillStyle = color;
          context.fillRect(0, 0, 1, 1);
        };
        const luminance = () => {
          const [r, g, b] = Array.from(context.getImageData(0, 0, 1, 1).data, (byte) => {
            const channel = byte / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
        };
        paint(getComputedStyle(element.closest(".composer")!).backgroundColor);
        paint(getComputedStyle(element).backgroundColor);
        const background = luminance();
        paint(getComputedStyle(element.querySelector(".composer-count-control__label")!).color);
        return (luminance() + 0.05) / (background + 0.05);
      });

    for (const { id, dark } of APP_COLOR_OPTIONS) {
      await page.evaluate((color) => {
        document.documentElement.style.setProperty("--color-instance-dark", color);
      }, dark);
      for (const button of buttons) {
        await page.mouse.move(1, 1);
        expect(await contrast(button), `${id}: resting`).toBeGreaterThanOrEqual(4.5);
        await button.hover();
        expect(await contrast(button), `${id}: hovered`).toBeGreaterThanOrEqual(4.5);
        await page.mouse.down();
        expect(await contrast(button), `${id}: pressed`).toBeGreaterThanOrEqual(4.5);
        await page.mouse.move(1, 1);
        await page.mouse.up();
      }
    }
  } finally {
    await page.close();
  }
});

test("Chromium composer owns its labeled textarea without changing newline, composition or send behavior", async () => {
  const page = (await browser.newPage()) as Page;
  try {
    await page.goto(url);
    const input = page.getByRole("textbox", { name: "Chat message", exact: true });
    await input.waitFor();
    expect(
      await input.evaluate((element: HTMLTextAreaElement) => ({
        form: element.form?.className,
        labels: Array.from(element.labels ?? [], (label) => label.textContent),
      })),
    ).toEqual({ form: "composer", labels: ["Chat message"] });
    await input.fill("First line");
    await input.press("Enter");
    await input.press("Shift+Enter");
    await input.dispatchEvent("compositionstart", { data: "あ" });
    await input.dispatchEvent("keydown", { key: "Enter", isComposing: true });
    await input.dispatchEvent("compositionend", { data: "あ" });
    expect(await input.inputValue()).toBe("First line\n\n");
    const submissions = async () => JSON.parse((await page.locator("#submissions").textContent())!);
    expect(await submissions()).toEqual([]);
    await input.fill("Send this");
    await input.press("Control+Enter");
    await input.press("Meta+Enter");
    await page.getByRole("button", { name: "Send prompt", exact: true }).click();
    expect(await submissions()).toEqual(["Send this", "Send this", "Send this"]);
    // Native form submission stays in the SPA and uses the same guarded send action.
    await input.evaluate((element: HTMLTextAreaElement) => element.form!.requestSubmit());
    expect(await submissions()).toHaveLength(4);
    expect(page.url()).toBe(url);
  } finally {
    await page.close();
  }
}, 30_000);

test("keeps stream controls centered independently of the left and right compose actions", async () => {
  for (const [name, width, hasTouch] of [
    ["desktop", 1100, false],
    ["wide-mobile-safe-area", 450, true],
    ["iphone-portrait", 393, true],
    ["iphone-compact", 375, true],
    ["just-above-short-label", 355, true],
    ["narrow", 300, true],
  ] as const) {
    const context = (await browser.newContext({
      viewport: { width, height: name === "iphone-portrait" ? 852 : 570 },
      isMobile: hasTouch,
      hasTouch,
    })) as unknown as import("playwright-core").BrowserContext;
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(5_000);
      await page.goto(`${url}?header&drafts&tasks&streaming`);
      // In the production build, the global chrome styles can load after the SFC's styles.
      const sideInset = name === "wide-mobile-safe-area" ? 12 : 0;
      await page.addStyleTag({
        content: `.chrome-button { padding: 0 0.75rem; gap: 0.4rem; }
          :root { --safe-area-left: ${sideInset}px; --safe-area-right: ${sideInset}px; }
          ${name === "iphone-portrait" ? ":root { font-size: 20px; }" : ""}`,
      });
      await page.evaluate(() => document.fonts.ready);
      const rem = await page.evaluate(() =>
        parseFloat(getComputedStyle(document.documentElement).fontSize),
      );
      const attach = page.getByRole("button", { name: "Add files" });
      const tasks = page.getByRole("button", { name: "Running tasks" });
      const drafts = page.getByRole("button", { name: /^Drafts:/ });
      const send = page.getByRole("button", { name: "Send prompt" });
      const stop = page.getByRole("button", { name: "Stop", exact: true });
      const group = page.locator(".streaming-stop-control");
      const input = page.getByRole("textbox", { name: "Chat message" });
      await input.fill("Testing the composer toolbar");
      const adjacentInset = (button: typeof attach) =>
        button.evaluate(
          (element) =>
            (element.getBoundingClientRect().width -
              element.querySelector("svg")!.getBoundingClientRect().width) /
            2,
        );
      await page.locator('input[type="file"]').setInputFiles({
        name: `${"A very long attachment filename ".repeat(5)}.txt`,
        mimeType: "text/plain",
        buffer: Buffer.from("attachment content"),
      });
      await page.locator(".composer__chip").waitFor();
      const geometry = async () => {
        const [a, t, d, s, g] = await Promise.all([
          attach.boundingBox(),
          (await tasks.count()) ? tasks.boundingBox() : null,
          drafts.boundingBox(),
          send.boundingBox(),
          (await group.count()) ? group.boundingBox() : null,
        ]);
        return { a: a!, t, d: d!, s: s!, g };
      };
      const ink = (icon: typeof attach) =>
        icon.evaluate((element) => getComputedStyle(element).stroke);
      const attachmentInk = await ink(attach.locator("svg"));
      const toolbarWeight = await attach.evaluate(
        (element) => getComputedStyle(element).fontWeight,
      );
      async function checkCounts(taskCount: string | undefined, draftCount: string) {
        for (const [button, label] of [
          [tasks, taskCount],
          [drafts, draftCount],
        ] as const) {
          if (!label) continue;
          expect(await button.getAttribute("title")).toBe(label);
          expect(
            await button.locator(".composer-count-control__label").evaluate((element) => ({
              text: (element as HTMLElement).innerText,
              fits: element.scrollWidth <= element.clientWidth,
              color: getComputedStyle(element).color,
              weight: getComputedStyle(element).fontWeight,
            })),
            `${name}: ${label}`,
          ).toEqual({
            text: name === "narrow" ? label.split(" ")[0] : label,
            fits: true,
            color: attachmentInk,
            weight: toolbarWeight,
          });
          expect(await ink(button.locator(":scope > svg"))).toBe(attachmentInk);
          const hit = (await button.boundingBox())!;
          expect(hit.width).toBeGreaterThanOrEqual(44);
          expect(hit.height).toBeGreaterThanOrEqual(44);
          const inset = await adjacentInset(button === tasks ? attach : send);
          expect(
            await button.evaluate((element) => {
              const icon = element.querySelector("svg")!.getBoundingClientRect();
              const label = element
                .querySelector(".composer-count-control__label")!
                .getBoundingClientRect();
              const bounds = element.getBoundingClientRect();
              return {
                iconInset: icon.left - bounds.left,
                textInset: bounds.right - label.right,
                iconTextGap: label.left - icon.right,
              };
            }),
          ).toEqual({
            iconInset: inset,
            textInset: inset,
            iconTextGap: rem / 4,
          });
        }
      }
      const active = await geometry();
      await checkCounts("1 task", "0 drafts");
      const gap = width <= 360 ? 4 : width <= 416 ? 6 : 8;
      const spacing = async (first: typeof attach, next: typeof attach) => {
        const [left, right] = await Promise.all([first.boundingBox(), next.boundingBox()]);
        return right!.x - left!.x - left!.width;
      };
      expect(active.t!.x - active.a.x - active.a.width).toBeCloseTo(gap, 0);
      expect(active.s.x - active.d.x - active.d.width).toBeCloseTo(gap, 0);
      // The spinner rotates, so its painted bounds do not represent the flex gap.
      expect(await group.evaluate((element) => getComputedStyle(element).columnGap)).toBe(
        `${gap}px`,
      );

      const header = page.locator("header.header");
      const settings = header.getByRole("button", { name: "Settings" });
      const browserButton = header.getByRole("button", { name: "Open browser" });
      const cron = header.getByRole("button", { name: "Cron" });
      const tools = header.getByRole("button", { name: "Workspaces and tools" });
      const usage = header.getByRole("button", { name: "Usage limits" });
      const contextUsage = header.locator(".session-header-status__context");
      const connection = header.locator(".session-header-status__connection");
      for (const [first, next] of [
        [settings, browserButton],
        [browserButton, cron],
        [cron, tools],
        [usage, contextUsage],
        [contextUsage, connection],
      ] as const) {
        expect(await spacing(first, next)).toBeCloseTo(gap, 0);
      }
      const settingsX = (await settings.boundingBox())!.x;
      const connectionBox = (await connection.boundingBox())!;
      expect(settingsX).toBeGreaterThanOrEqual(sideInset + 4);
      expect(connectionBox.x + connectionBox.width).toBeLessThanOrEqual(width - sideInset - 4);
      expect(await spacing(tools, usage)).toBeGreaterThanOrEqual(0);
      expect(active.g!.x).toBeGreaterThanOrEqual(active.t!.x + active.t!.width - 1);
      expect(active.g!.x + active.g!.width).toBeLessThanOrEqual(active.d.x + 1);
      expect(active.g!.x + active.g!.width / 2).toBeCloseTo(width / 2, 0);
      expect(active.a.x).toBeGreaterThanOrEqual(sideInset);
      expect(active.s.x + active.s.width).toBeGreaterThanOrEqual(width - sideInset - 8);
      expect(active.s.x + active.s.width).toBeLessThanOrEqual(width - sideInset);
      expect(
        await page.locator(".composer__chip").evaluate((chip) => ({
          inViewport: chip.getBoundingClientRect().right <= window.innerWidth,
          truncated: chip.scrollWidth > chip.clientWidth,
        })),
      ).toEqual({ inViewport: true, truncated: hasTouch });
      expect(await group.locator(".spinner").isVisible()).toBe(true);
      expect(await stop.isEnabled()).toBe(true);
      const capture = async (state: string) => {
        if (process.env.BATTY_UI_SCREENSHOTS === "1")
          await page.screenshot({ path: `.tmp/ui-feedback/batty-composer-${name}-${state}.png` });
      };
      await page.emulateMedia({ reducedMotion: "reduce" });
      const background = (locator: typeof attach) =>
        locator.evaluate((element) => getComputedStyle(element).backgroundColor);
      if (hasTouch) {
        // Even if a browser synthesizes :hover after a tap, the hover rule is gated by input capability.
        expect(await page.evaluate(() => matchMedia("(hover: hover)").matches)).toBe(false);
        const idleBackground = await background(stop);
        await stop.tap();
        await expect.poll(() => background(stop)).toBe(idleBackground);
      } else {
        const plain = await background(drafts);
        await drafts.hover();
        await expect.poll(() => background(drafts)).not.toBe(plain);
        const green = await background(drafts);
        for (const button of [attach, tasks, send]) {
          await button.hover();
          await expect.poll(() => background(button)).toBe(green);
        }
        await stop.hover();
        await expect.poll(() => background(stop)).not.toBe(plain);
        expect(await background(stop)).not.toBe(green);
        await input.fill("");
        await page.locator(".composer__chip").click();
        expect(await send.isDisabled()).toBe(true);
        await page.mouse.move(active.s.x + active.s.width / 2, active.s.y + active.s.height / 2);
        expect(await background(send)).toBe(plain);
        await input.fill("Testing the composer toolbar");
      }
      await capture("streaming");

      await page.evaluate(() => window.dispatchEvent(new Event("fixture:finish-main")));
      await stop.waitFor({ state: "hidden" });
      await checkCounts("1 task", "0 drafts");
      await capture("idle-with-tasks");
      await page.evaluate(() => window.dispatchEvent(new Event("fixture:start-main")));
      await stop.waitFor();
      expect(await geometry()).toEqual(active);

      for (const [trigger, label] of [
        [tasks, "Running tasks"],
        [drafts, "Drafts"],
      ] as const) {
        if (hasTouch) await trigger.tap();
        else await trigger.click();
        const panel = page.getByRole("dialog", { name: label, exact: true });
        await expect
          .poll(async () => {
            const [button, bounds] = await Promise.all([
              trigger.boundingBox(),
              panel.boundingBox(),
            ]);
            if (!button || !bounds) return null;
            const expected = Math.max(8, Math.min(button.x, width - 8 - bounds.width));
            return Math.abs(expected - bounds.x) < 1 && bounds.y + bounds.height < button.y;
          })
          .toBe(true);
        await capture(label === "Drafts" ? "drafts" : "tasks");
        await page.keyboard.press("Escape");
        await panel.waitFor({ state: "hidden" });
      }
      await page.evaluate(() => window.dispatchEvent(new Event("fixture:finish-agent")));
      await tasks.waitFor({ state: "hidden" });
      expect(await geometry()).toEqual({ ...active, t: null });
      await capture("streaming-no-tasks");
      await page.evaluate(() => window.dispatchEvent(new Event("fixture:finish-main")));
      await stop.waitFor({ state: "hidden" });
      expect(await geometry()).toEqual({ ...active, t: null, g: null });
      await checkCounts(undefined, "0 drafts");
      await capture("idle");
      await context.setOffline(true);
      await expect.poll(() => connection.getAttribute("aria-label")).toBe("Offline");
      await page.getByText("Offline", { exact: true }).waitFor({ state: "visible" });
      expect(await send.isDisabled()).toBe(true);
      expect(await geometry()).toEqual({ ...active, t: null, g: null });
      await capture("offline");
      await page.evaluate(() => window.dispatchEvent(new Event("fixture:hide-header-controls")));
      await browserButton.waitFor({ state: "hidden" });
      await usage.waitFor({ state: "hidden" });
      expect(await spacing(settings, cron)).toBeCloseTo(gap, 0);
      expect(await spacing(contextUsage, connection)).toBeCloseTo(gap, 0);
      expect((await settings.boundingBox())!.x).toBe(settingsX);
      expect(await connection.boundingBox()).toEqual(connectionBox);
    } finally {
      await context.close();
    }
  }
}, 60_000);

test("drafts preserve conflicts, attachments and failed messages across reload and reconnect", async () => {
  const phone = (await browser.newContext({
    viewport: { width: 320, height: 568 },
    hasTouch: true,
  })) as unknown as import("playwright-core").BrowserContext;
  const desktop =
    (await browser.newContext()) as unknown as import("playwright-core").BrowserContext;
  try {
    const first = await phone.newPage();
    const second = await desktop.newPage();
    const draftUrl = `${url}?drafts&tasks&streaming`;
    const composer = (page: Page) => page.getByRole("textbox", { name: "Chat message" });
    const open = (page: Page) => page.getByRole("button", { name: /^Drafts:/ });
    const list = (page: Page) => page.getByRole("dialog", { name: "Drafts" });
    const header = (page: Page) => list(page).locator("header");
    const save = (page: Page) => header(page).getByRole("button", { name: "Save to drafts" });
    const checkSavePlacement = async (page: Page, hasDraft = false) => {
      const [title, button, box] = await Promise.all([
        header(page).getByText("Drafts", { exact: true }).boundingBox(),
        save(page).boundingBox(),
        header(page).boundingBox(),
      ]);
      expect(button!.width).toBe(44);
      expect(button!.height).toBe(44);
      expect(button!.x).toBeGreaterThan(title!.x + title!.width);
      expect(box!.x + box!.width - button!.x - button!.width).toBeGreaterThanOrEqual(8);
      expect(button!.y - box!.y).toBeGreaterThanOrEqual(5);
      if (!hasDraft) return;
      const deletion = list(page).getByRole("button", { name: /^Delete draft:/ });
      expect(await deletion.getAttribute("title")).toBe("Delete draft");
      const action = (await deletion.boundingBox())!;
      const row = (await list(page).locator(".drafts-control__entry").boundingBox())!;
      expect(action.width).toBe(44);
      expect(action.height).toBe(44);
      expect(action.x).toBeCloseTo(button!.x, 0);
      expect(action.y - row.y).toBeGreaterThanOrEqual(5);
      expect(row.y + row.height - action.y - action.height).toBeGreaterThanOrEqual(5);
    };
    const checkAttachmentRadius = async (page: Page, filename: string) => {
      const chip = page.getByRole("button", { name: `${filename} ×`, exact: true });
      await chip.waitFor();
      expect(await chip.evaluate((element) => getComputedStyle(element).borderRadius)).toBe(
        await open(page).evaluate((element) => getComputedStyle(element).borderRadius),
      );
    };
    const capture = async (page: Page, name: string) => {
      if (process.env.BATTY_UI_SCREENSHOTS === "1") {
        await page.screenshot({ path: `.tmp/ui-feedback/batty-drafts-${name}.png` });
      }
    };
    const offlineDraft = `Offline original with a long draft preview ${"that stays on one line ".repeat(8)}\nSecond line`;
    await first.goto(draftUrl);
    await phone.setOffline(true);
    expect(
      await first.locator('.composer__actions-row button[aria-label="Save to drafts"]').count(),
    ).toBe(0);
    await open(first).tap();
    await save(first).waitFor();
    expect(await save(first).isDisabled()).toBe(true);
    await checkSavePlacement(first);
    await first.keyboard.press("Escape");
    await list(first).waitFor({ state: "hidden" });
    await composer(first).fill(offlineDraft);
    await first.locator('input[type="file"]').setInputFiles({
      name: 'a"b.txt',
      mimeType: "text/plain",
      buffer: Buffer.from("attachment bytes"),
    });
    await checkAttachmentRadius(first, 'a"b.txt');
    await capture(first, "attachment-mobile");
    await open(first).tap();
    await save(first).tap();
    await first.getByRole("button", { name: "Drafts: 1 draft" }).waitFor();
    expect(await composer(first).inputValue()).toBe("");
    expect(await save(first).isDisabled()).toBe(true);
    await first.keyboard.press("Escape");
    await list(first).waitFor({ state: "hidden" });
    await composer(first).fill("Unsaved new text");
    await open(first).focus();
    await open(first).press("Enter");
    const checkPopoverAlignment = async (page: Page, placement: "trigger" | "clamped") => {
      await expect
        .poll(async () => {
          const [trigger, panel] = await Promise.all([
            open(page).boundingBox(),
            list(page).boundingBox(),
          ]);
          if (!trigger || !panel) return null;
          const right = page.viewportSize()!.width - 8;
          return {
            underTrigger: Math.abs(panel.x - trigger.x) < 1,
            atRightLimit: Math.abs(panel.x + panel.width - right) < 1,
            fitsAtTrigger: trigger.x + panel.width <= right,
            withinViewport: panel.x >= 7 && panel.x + panel.width <= right + 1,
          };
        })
        .toEqual({
          underTrigger: placement === "trigger",
          atRightLimit: placement === "clamped",
          fitsAtTrigger: placement === "trigger",
          withinViewport: true,
        });
    };
    await checkPopoverAlignment(first, "clamped");
    await checkSavePlacement(first, true);
    expect(
      await list(first)
        .locator("strong")
        .evaluate((element) => {
          const style = getComputedStyle(element);
          return style.textOverflow === "ellipsis" && element.scrollWidth > element.clientWidth;
        }),
    ).toBe(true);
    await capture(first, "popover-mobile");
    await first.setViewportSize({ width: 390, height: 640 });
    await checkPopoverAlignment(first, "clamped");
    await first.keyboard.press("Escape");
    await list(first).waitFor({ state: "hidden" });
    await open(first).tap();
    await list(first)
      .getByRole("button", { name: /^Offline original/ })
      .tap();
    await first.getByRole("button", { name: 'a"b.txt ×' }).waitFor();
    expect(await composer(first).inputValue()).toBe(offlineDraft);
    expect(await composer(first).evaluate((node) => document.activeElement === node)).toBe(true);
    await first.evaluate(() => window.dispatchEvent(new Event("fixture:restore")));
    expect(await composer(first).inputValue()).toBe(offlineDraft);
    await first.getByRole("button", { name: "Drafts: 2 drafts" }).waitFor();

    // Reload the document from the fixture host, but keep draft API traffic
    // unavailable until the explicit reconnect below.
    await first.route("**/api/drafts**", (route) => route.abort());
    await phone.setOffline(false);
    await first.reload();
    await first.getByRole("button", { name: 'a"b.txt ×' }).waitFor();
    expect(await composer(first).inputValue()).toBe(offlineDraft);
    await open(first).tap();
    await list(first).getByRole("button", { name: "Delete draft: Unsaved new text" }).tap();
    await first.getByRole("button", { name: "Drafts: 1 draft" }).waitFor();
    await list(first)
      .getByRole("button", { name: /^Failed prompt/ })
      .waitFor();
    await first.keyboard.press("Escape");
    await first.unroute("**/api/drafts**");
    await open(first).tap();
    await expect
      .poll(async () =>
        (await api.inject("/api/drafts"))
          .json()
          .drafts.map((draft: { text: string }) => draft.text),
      )
      .toEqual(["Failed prompt"]);
    await second.goto(draftUrl);
    await second.getByRole("button", { name: "Drafts: 1 draft" }).waitFor();
    await open(second).click();
    await checkPopoverAlignment(second, "clamped");
    const desktopViewport = second.viewportSize()!;
    await second.setViewportSize({ width: 390, height: 640 });
    await checkPopoverAlignment(second, "clamped");
    await second.setViewportSize(desktopViewport);
    await checkPopoverAlignment(second, "clamped");
    await checkSavePlacement(second, true);
    expect(await save(second).isDisabled()).toBe(true);
    await capture(second, "popover-desktop");
    await list(second)
      .getByRole("button", { name: /^Failed prompt/ })
      .click();
    await checkAttachmentRadius(second, "failed.txt");
    await capture(second, "attachment-desktop");
    expect(await composer(second).inputValue()).toBe("Failed prompt");
    await expect.poll(async () => (await api.inject("/api/drafts")).json().drafts).toEqual([]);
    await open(second).focus();
    await open(second).press("Enter");
    await save(second).waitFor();
    expect(await save(second).isEnabled()).toBe(true);
    await save(second).press("Enter");
    await second.getByRole("button", { name: "Drafts: 1 draft" }).waitFor();
    expect(await composer(second).inputValue()).toBe("");
    expect(await save(second).isDisabled()).toBe(true);
    await list(second).getByRole("button", { name: "Delete draft: Failed prompt" }).click();
    await second.getByRole("button", { name: "Drafts: 0 drafts" }).waitFor();
    await expect.poll(async () => (await api.inject("/api/drafts")).json().drafts).toEqual([]);
    await first.bringToFront();
    await first.keyboard.press("Escape");
    await open(first).tap();
    await list(first).getByText("No drafts.").waitFor();
  } finally {
    await desktop.close();
    await phone.close();
  }
}, 45_000);

test("keeps Drafts action columns lined up with a classic scrollbar", async () => {
  const page = (await browser.newPage({ viewport: { width: 760, height: 560 } })) as Page;
  try {
    await page.route("**/api/drafts**", (route) => route.abort());
    await page.goto(`${url}?drafts`);
    await page.addStyleTag({
      content: ".composer-list-popover__list::-webkit-scrollbar { width: 15px; }",
    });
    const open = page.getByRole("button", { name: /^Drafts:/ });
    const dialog = page.getByRole("dialog", { name: "Drafts" });
    const save = dialog.getByRole("button", { name: "Save to drafts" });
    for (let i = 1; i <= 8; i++) {
      await page.getByRole("textbox", { name: "Chat message" }).fill(`Draft row ${i}`);
      await open.click();
      await save.click();
      await expect
        .poll(() => dialog.getByRole("button", { name: /^Delete draft:/ }).count())
        .toBe(i);
      if (i < 8) await page.keyboard.press("Escape");
    }
    const list = dialog.locator(".composer-list-popover__list");
    await expect
      .poll(() =>
        list.evaluate((element) => (element as HTMLElement).offsetWidth - element.clientWidth),
      )
      .toBeGreaterThan(0);
    const header = dialog.locator("header");
    const top = (await header.boundingBox())!.y;
    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    expect((await header.boundingBox())!.y).toBeCloseTo(top, 0);
    const action = dialog.getByRole("button", { name: "Delete draft: Draft row 1", exact: true });
    expect((await action.boundingBox())!.x).toBeCloseTo((await save.boundingBox())!.x, 0);
  } finally {
    await page.close();
  }
}, 30_000);

test("durably recovers an interrupted send and an abandoned composer without sharing live tab slots", async () => {
  const context =
    (await browser.newContext()) as unknown as import("playwright-core").BrowserContext;
  try {
    const first = await context.newPage();
    await context.route("**/api/drafts**", (route) => route.abort());
    await first.goto(`${url}?drafts&journal`);
    const input = (page: Page) => page.getByRole("textbox", { name: "Chat message" });
    const submit = first.getByRole("button", { name: "Send prompt" });
    await input(first).fill("Failed real submission");
    await submit.click();
    await expect.poll(() => input(first).inputValue()).toBe("");
    await input(first).fill("Do not overwrite");
    await first.evaluate(() => window.dispatchEvent(new Event("fixture:reject-send")));
    await first.getByRole("button", { name: "Drafts: 1 draft" }).waitFor();
    expect(await input(first).inputValue()).toBe("Do not overwrite");
    await input(first).fill("Interrupted send");
    await submit.click();
    await expect.poll(() => input(first).inputValue()).toBe("");
    await first.reload();
    await first.getByRole("button", { name: "Drafts: 2 drafts" }).waitFor();
    await input(first).fill("First tab text");
    // An opener-created page inherits sessionStorage, like Duplicate Tab.
    const popupEvent = first.waitForEvent("popup");
    await input(first).evaluate((node: HTMLTextAreaElement) => {
      const link = node.ownerDocument.createElement("a");
      link.href = location.href;
      link.target = "_blank";
      link.rel = "opener";
      link.click();
    });
    const second = await popupEvent;
    await input(second).fill("Second tab text");
    await expect.poll(() => input(first).inputValue()).toBe("First tab text");
    await first.close();
    await second.getByRole("button", { name: /^Drafts:/ }).click();
    await second
      .getByRole("dialog", { name: "Drafts" })
      .getByRole("button", { name: "First tab text", exact: true })
      .waitFor();
    expect(await input(second).inputValue()).toBe("Second tab text");
  } finally {
    await context.close();
  }
}, 30_000);
