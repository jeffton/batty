// @vitest-environment node
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { registerDraftRoutes } from "../../server/routes/drafts";
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
    await checkPopoverAlignment(second, "trigger");
    // Moving the toolbar to a smaller window flips to collision clamping,
    // and a wider window restores the button alignment without reopening.
    const desktopViewport = second.viewportSize()!;
    await second.setViewportSize({ width: 530, height: 640 });
    await checkPopoverAlignment(second, "clamped");
    await second.setViewportSize(desktopViewport);
    await checkPopoverAlignment(second, "trigger");
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
