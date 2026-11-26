// @vitest-environment node
import path from "node:path";
import vue from "@vitejs/plugin-vue";
import { chromium, type Browser, type Page } from "patchright";
import sharp from "sharp";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import type { SiteDescriptor } from "@/shared/types";
import { RpcError } from "@/shared/rpc";
import { closeBrowserFixtureServer, createBrowserFixtureServer } from "../test/browser-fixture";
import { fixtureOperation } from "../test/socket-fixture";

const fixture = "src/client/components/SiteSwitcher.fixture.html";
const baseUrl = "/nested/app";
const names = [
  "Weather and lake conditions",
  "Garmin training overview",
  "Upcoming events in Copenhagen",
  "Groundwater and well readings",
  "Morning briefing and calendar",
  "Train departures and platform updates",
  "Summerhouse maintenance and inventory checklist with a very long name",
];
const descriptor = (id: string, name: string): SiteDescriptor => ({
  kind: "site",
  id,
  name,
  url: `${baseUrl}/sites/${id}/`,
  public: false,
});

let server: ViteDevServer;
let browser: Browser;
let url: string;

beforeAll(async () => {
  server = await createBrowserFixtureServer(fixture, {
    plugins: [vue()],
    define: { __BATTY_BUILD_ID__: JSON.stringify("dev") },
    resolve: { alias: { "@": path.resolve("src") } },
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  url = server.resolvedUrls!.local[0]! + fixture;
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  if (server) await closeBrowserFixtureServer(server);
});

async function siteFixture(page: Page, initialSites: SiteDescriptor[], initialRecent: string[]) {
  let sites = [...initialSites];
  let recent = [...initialRecent];
  let latestCalls = 0;
  let catalogCalls = 0;
  const opened: string[] = [];
  const loaded: string[] = [];
  const saves: [string, boolean][] = [];
  const catalog = () => ({
    sites: [
      ...recent.map((id) => sites.find((site) => site.id === id)!),
      ...sites.filter((site) => !recent.includes(site.id)),
    ],
  });
  await fixtureOperation(server, page, "site.latest", () => {
    latestCalls++;
    return { value: catalog().sites[0] ?? null };
  });
  await fixtureOperation(server, page, "site.catalog", () => {
    catalogCalls++;
    return { value: catalog() };
  });
  await fixtureOperation(server, page, "site.get", ({ siteId }) => ({
    value: sites.find((site) => site.id === siteId)!,
  }));
  await fixtureOperation(server, page, "site.open", ({ siteId }) => {
    const site = sites.find((site) => site.id === siteId)!;
    opened.push(siteId);
    recent = [siteId, ...recent.filter((id) => id !== siteId)];
    return { value: site };
  });
  await fixtureOperation(server, page, "site.public", ({ siteId, public: isPublic }) => {
    const site = sites.find((site) => site.id === siteId)!;
    site.public = isPublic;
    saves.push([siteId, isPublic]);
    return { value: site };
  });
  await page.route(/\/nested\/app\/sites\/[^/]+\//, (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-2)!;
    const site = sites.find((site) => site.id === id)!;
    loaded.push(id);
    return route.fulfill({
      contentType: "text/html",
      body: `<h1>${site.name}</h1><button style="position:fixed;bottom:12px;left:12px" onclick="this.textContent='Activated'">Page action</button>`,
    });
  });
  return {
    add(site: SiteDescriptor) {
      sites = [...sites, site];
    },
    latestCalls: () => latestCalls,
    catalogCalls: () => catalogCalls,
    loaded,
    opened,
    saves,
  };
}

test("opens the newest site with no visit history, then uses the most recent visit, including chat opens", async () => {
  const page = await browser.newPage();
  try {
    const state = await siteFixture(page, [], []);
    await page.goto(url);
    const launcher = page.getByRole("button", { name: "Sites", exact: true });
    const switcher = page.getByRole("dialog", { name: "Sites", exact: true });
    const close = switcher.getByRole("button", { name: "Close sites" });
    const choices = page.getByRole("list", { name: "Available sites" });
    await launcher.click();
    await switcher.getByText("No sites yet.").waitFor();
    expect(await switcher.locator("iframe").count()).toBe(0);
    expect(state.opened).toEqual([]);
    await close.click();
    await switcher.waitFor({ state: "hidden" });

    state.add(descriptor("newest", "Newest site"));
    state.add(descriptor("attached", "Chat attachment"));
    await launcher.click();
    await switcher.frameLocator("iframe").getByRole("heading", { name: "Newest site" }).waitFor();
    expect(await choices.isVisible()).toBe(false);
    await expect.poll(() => state.opened).toEqual(["newest"]);
    await close.click();
    await switcher.waitFor({ state: "hidden" });

    await page.getByRole("button", { name: "Open site", exact: true }).click();
    const chat = page.getByRole("dialog", { name: "Chat attachment", exact: true });
    await chat.frameLocator("iframe").getByRole("heading", { name: "Chat attachment" }).waitFor();
    await expect.poll(() => state.opened).toEqual(["newest", "attached"]);
    await chat.getByRole("button", { name: "Close site" }).click();
    await launcher.click();
    await switcher
      .frameLocator("iframe")
      .getByRole("heading", { name: "Chat attachment" })
      .waitFor();
    await expect.poll(() => state.opened).toEqual(["newest", "attached", "attached"]);
    expect(state.latestCalls()).toBe(3);
    expect(state.catalogCalls()).toBe(0);
  } finally {
    await page.close();
  }
}, 30_000);

test.each([
  { name: "desktop", width: 1280, height: 840, mobile: false },
  { name: "320px touch", width: 320, height: 660, mobile: true },
])(
  "selects sites from a compact header menu, keeps the preview open, and preserves Public on $name",
  async ({ width, height, mobile }) => {
    const context = await browser.newContext({
      viewport: { width, height },
      isMobile: mobile,
      hasTouch: mobile,
      colorScheme: mobile ? "dark" : "light",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    try {
      const recent = names.map((name, i) => descriptor(`recent-${i}`, name));
      const neverOpened = descriptor("new", "Never opened");
      const allSites = [...recent, neverOpened];
      const state = await siteFixture(
        page,
        allSites,
        recent.map((site) => site.id),
      );
      await page.goto(url);
      const activate = (target: ReturnType<Page["locator"]>) =>
        mobile ? target.tap() : target.click();
      const launcher = page.getByRole("button", { name: "Sites", exact: true });
      const switcher = page.getByRole("dialog", { name: "Sites", exact: true });
      const trigger = switcher.getByRole("button", { name: "Choose site", exact: true });
      const close = switcher.getByRole("button", { name: "Close sites" });
      const frame = switcher.frameLocator("iframe");
      const choices = page.getByRole("list", { name: "Available sites" });
      const first = choices.getByRole("button", { name: names[0], exact: true });
      const selected = choices.getByRole("button", { name: neverOpened.name });
      expect(await launcher.locator("svg").getAttribute("class")).toContain("lucide-newspaper");
      expect(
        await page
          .getByRole("button", { name: "Open browser" })
          .locator("svg")
          .getAttribute("class"),
      ).toContain("lucide-globe");
      const headerButtons = page.locator("header.header .header__button");
      expect(
        await headerButtons.evaluateAll((buttons) =>
          buttons.map((button) => button.getAttribute("aria-label")),
        ),
      ).toEqual(["Settings", "Sites", "Open browser", "Cron", "Workspaces and tools"]);
      const settingsBounds = (await headerButtons.first().boundingBox())!;
      const sitesBounds = (await launcher.boundingBox())!;
      expect(sitesBounds.x).toBeGreaterThan(settingsBounds.x);
      expect(sitesBounds.y).toBe(settingsBounds.y);
      if (mobile && process.env.BATTY_SITE_SWITCHER_SCREENSHOTS) {
        await page.screenshot({
          path: `${process.env.BATTY_SITE_SWITCHER_SCREENSHOTS}/toolbar.png`,
        });
      }
      await activate(launcher);
      await frame.getByRole("heading", { name: names[0] }).waitFor();
      const sheet = (await switcher.boundingBox())!;
      expect(sheet.x).toBe(0);
      expect(sheet.width).toBe(page.viewportSize()!.width);
      expect(sheet.y).toBeGreaterThan(0);
      expect(sheet.y + sheet.height).toBe(page.viewportSize()!.height);
      await expect.poll(() => state.opened).toEqual([recent[0]!.id]);
      expect(await trigger.locator("svg").getAttribute("class")).toContain("lucide-square-stack");
      expect(await switcher.locator("iframe").getAttribute("sandbox")).not.toContain(
        "allow-same-origin",
      );

      if (mobile) await activate(trigger);
      else await trigger.press("Enter");
      await choices.waitFor();
      expect(await first.evaluate((element) => element.matches(":focus"))).toBe(!mobile);
      expect(await first.evaluate((element) => element.matches(":focus-visible"))).toBe(!mobile);
      expect(await first.getAttribute("aria-current")).toBe("page");
      expect(
        (await choices.getByRole("button").allTextContents()).map((name) => name.trim()),
      ).toEqual(allSites.map((site) => site.name));
      await expect
        .poll(async () => {
          const menu = await choices.locator("..").boundingBox();
          const preview = await switcher.boundingBox();
          return (
            !!menu &&
            !!preview &&
            menu.x > preview.x &&
            Math.abs(preview.x + preview.width - (menu.x + menu.width) - 8) < 1 &&
            menu.height < preview.height
          );
        })
        .toBe(true);
      expect(await switcher.locator("iframe").isVisible()).toBe(true);
      await expect.poll(() => switcher.locator("iframe").getAttribute("inert")).toBe("");
      expect(await page.locator(":popover-open").count()).toBe(2);
      expect(state.loaded).toEqual([recent[0]!.id]);
      if (process.env.BATTY_SITE_SWITCHER_SCREENSHOTS) {
        await page.screenshot({
          path: `${process.env.BATTY_SITE_SWITCHER_SCREENSHOTS}/${mobile ? "mobile" : "desktop"}.png`,
        });
      }

      if (!mobile) {
        await page.keyboard.press("Escape");
        await choices.waitFor({ state: "hidden" });
        expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(true);
        await activate(trigger);
        await choices.waitFor();
        expect(await first.evaluate((element) => element.matches(":focus-visible"))).toBe(false);
      }
      const siteAction = frame.getByRole("button", { name: "Page action" });
      const bounds = (await siteAction.boundingBox())!;
      const x = bounds.x + bounds.width / 2;
      const y = bounds.y + bounds.height / 2;
      if (mobile) await page.touchscreen.tap(x, y);
      else await page.mouse.click(x, y);
      await choices.waitFor({ state: "hidden" });
      expect(await siteAction.isVisible()).toBe(true);
      await activate(siteAction);
      await frame.getByRole("button", { name: "Activated" }).waitFor();
      expect(state.opened).toEqual([recent[0]!.id]);
      await activate(trigger);
      await activate(first);
      await choices.waitFor({ state: "hidden" });
      expect(state.loaded).toEqual([recent[0]!.id]);
      expect(state.opened).toEqual([recent[0]!.id]);

      if (mobile) {
        await activate(trigger);
        await activate(selected);
      } else {
        await trigger.press("Enter");
        for (const _site of recent) await page.keyboard.press("Tab");
        expect(await selected.evaluate((element) => element === document.activeElement)).toBe(true);
        await page.keyboard.press("Enter");
      }
      await choices.waitFor({ state: "hidden" });
      await frame.getByRole("heading", { name: neverOpened.name }).waitFor();
      await expect.poll(() => state.opened).toEqual([recent[0]!.id, neverOpened.id]);
      expect(await switcher.locator(".full-popover__title").textContent()).toBe(neverOpened.name);
      expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(true);

      const share = switcher.getByRole("button", { name: "Share site", exact: true });
      const shareMenu = page.getByRole("group", { name: "Share site" });
      const copy = shareMenu.getByRole("button", { name: "Copy link" });
      const publicity = shareMenu.getByRole("switch", { name: "Public" });
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      expect(await publicity.isVisible()).toBe(false);
      if (mobile) await activate(share);
      else await share.press("Enter");
      await shareMenu.waitFor();
      expect(await copy.evaluate((element) => element.matches(":focus"))).toBe(!mobile);
      expect(await copy.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe(
        mobile ? "none" : "solid",
      );
      if (mobile) {
        await page.keyboard.press("Tab");
        expect(await copy.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
      }
      await expect.poll(() => switcher.locator("iframe").getAttribute("inert")).toBe("");
      const menuBounds = (await shareMenu.boundingBox())!;
      const previewBounds = (await switcher.boundingBox())!;
      expect(menuBounds.width).toBeLessThan(previewBounds.width);
      expect(menuBounds.height).toBeLessThan(previewBounds.height);
      const copyLink = async (id: string) => {
        if (mobile) await activate(copy);
        else {
          await expect
            .poll(() => copy.evaluate((element) => element === document.activeElement))
            .toBe(true);
          await page.keyboard.press("Enter");
        }
        await shareMenu.getByRole("button", { name: "Copied" }).waitFor();
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
          new URL(`${baseUrl}/sites/${id}/`, url).href,
        );
      };
      await copyLink(neverOpened.id);
      expect(state.saves).toEqual([]);
      if (process.env.BATTY_SITE_SWITCHER_SCREENSHOTS)
        await page.screenshot({
          path: `${process.env.BATTY_SITE_SWITCHER_SCREENSHOTS}/share-${mobile ? "mobile" : "desktop"}.png`,
        });
      if (!mobile) {
        await page.keyboard.press("Tab");
        await expect
          .poll(() => publicity.evaluate((element) => element === document.activeElement))
          .toBe(true);
        expect(await publicity.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
        await page.keyboard.press("Space");
      } else await activate(publicity);
      await expect.poll(() => publicity.isChecked()).toBe(true);
      expect(state.saves).toEqual([[neverOpened.id, true]]);
      if (mobile) await activate(switcher.locator(".full-popover__title"));
      else {
        expect(await publicity.evaluate((element) => element === document.activeElement)).toBe(
          true,
        );
        await page.keyboard.press("Escape");
        await expect
          .poll(() => share.evaluate((element) => element === document.activeElement))
          .toBe(true);
      }
      await shareMenu.waitFor({ state: "hidden" });
      await activate(close);
      await switcher.waitFor({ state: "hidden" });
      await page.reload();
      await activate(launcher);
      await frame.getByRole("heading", { name: neverOpened.name }).waitFor();
      await activate(share);
      await expect.poll(() => publicity.isChecked()).toBe(true);
      await activate(publicity);
      await expect.poll(() => publicity.isChecked()).toBe(false);
      expect(state.saves).toEqual([
        [neverOpened.id, true],
        [neverOpened.id, false],
      ]);
      await activate(trigger);
      await shareMenu.waitFor({ state: "hidden" });
      await activate(first);
      await frame.getByRole("heading", { name: names[0] }).waitFor();
      if (!mobile) {
        await share.evaluate((element) => {
          element.addEventListener("mousedown", (event) => event.preventDefault(), { once: true });
        });
      }
      await activate(share);
      await copy.waitFor();
      expect(await copy.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("none");
      expect(await share.evaluate((element) => element.matches(":focus"))).toBe(true);
      if (!mobile) await page.keyboard.press("Tab");
      await copyLink(recent[0]!.id);
      expect(await publicity.isChecked()).toBe(false);
      expect(state.latestCalls()).toBe(2);
      expect(state.opened).toEqual([recent[0]!.id, neverOpened.id, neverOpened.id, recent[0]!.id]);
      await activate(trigger);
      expect(await first.getAttribute("aria-current")).toBe("page");
      await activate(close);
      await switcher.waitFor({ state: "hidden" });
      await choices.waitFor({ state: "hidden" });
      expect(await launcher.evaluate((element) => element === document.activeElement)).toBe(true);
    } finally {
      await context.close();
    }
  },
  30_000,
);

test.each(["dark", "light"] as const)(
  "paints the loading area in the shell's %s theme without recoloring the loaded site",
  async (colorScheme) => {
    const page = await browser.newPage({ colorScheme });
    const requested = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    try {
      const site = descriptor("slow-site", "Slow site");
      await siteFixture(page, [site], []);
      await page.route(`**${site.url}?*`, async (route) => {
        requested.resolve();
        await release.promise;
        await route.fulfill({
          contentType: "text/html",
          body: `<style>html { background: #f4efd7; }</style><h1>${site.name}</h1>`,
        });
      });
      await page.goto(url);
      await page.getByRole("button", { name: "Sites", exact: true }).click();
      await requested.promise;
      const frame = page.getByRole("dialog", { name: "Sites" }).locator("iframe");
      const pixel = async () => {
        const { x, y, width, height } = (await frame.boundingBox())!;
        const clip = {
          x: Math.floor(x + width / 2),
          y: Math.floor(y + height / 2),
          width: 1,
          height: 1,
        };
        const rgb = await sharp(await page.screenshot({ clip }))
          .removeAlpha()
          .raw()
          .toBuffer();
        return [...rgb];
      };
      const [red, green, blue] = await pixel();
      if (colorScheme === "dark") expect(Math.max(red!, green!, blue!)).toBeLessThan(80);
      else expect(Math.min(red!, green!, blue!)).toBeGreaterThan(230);
      release.resolve();
      await frame.contentFrame().getByRole("heading", { name: site.name }).waitFor();
      await expect.poll(pixel).toEqual([244, 239, 215]);
    } finally {
      release.resolve();
      await page.close();
    }
  },
  30_000,
);

test.each(["keyboard", "keyboard moved away", "touch"] as const)(
  "does not steal focus when the site list arrives after opening via %s",
  async (input) => {
    const touch = input === "touch";
    const context = await browser.newContext({
      viewport: { width: 320, height: 660 },
      isMobile: touch,
      hasTouch: touch,
    });
    const page = await context.newPage();
    const release = Promise.withResolvers<void>();
    try {
      const site = descriptor("current", "Current site");
      await siteFixture(page, [site], [site.id]);
      await fixtureOperation(server, page, "site.catalog", async (_input, _context, next) => {
        await release.promise;
        return next();
      });
      await page.goto(url);
      await page.getByRole("button", { name: "Sites", exact: true }).click();
      const switcher = page.getByRole("dialog", { name: "Sites", exact: true });
      const trigger = switcher.getByRole("button", { name: "Choose site", exact: true });
      const share = switcher.getByRole("button", { name: "Share site", exact: true });
      if (touch) await trigger.tap();
      else await trigger.press("Enter");
      const choices = page.getByRole("list", { name: "Available sites" });
      await expect.poll(() => switcher.locator("iframe").getAttribute("inert")).toBe("");
      expect(await choices.isVisible()).toBe(false);
      expect(await trigger.evaluate((element) => element.matches(":focus"))).toBe(true);
      if (input === "keyboard moved away") {
        await page.keyboard.press("Tab");
        expect(await share.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
      }
      release.resolve();
      const choice = choices.getByRole("button", { name: site.name });
      await choice.waitFor();
      expect(await choice.evaluate((element) => element.matches(":focus-visible"))).toBe(
        input === "keyboard",
      );
      if (input === "keyboard moved away") {
        expect(await share.evaluate((element) => element.matches(":focus"))).toBe(true);
      } else {
        if (touch) {
          expect(await trigger.evaluate((element) => element.matches(":focus"))).toBe(true);
          await page.keyboard.press("Tab");
          expect(await choice.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
        }
        await page.keyboard.press("Escape");
        await choices.waitFor({ state: "hidden" });
        expect(await trigger.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
      }
    } finally {
      release.resolve();
      await context.close();
    }
  },
  30_000,
);

test("a delayed open response cannot replace the current site", async () => {
  const page = await browser.newPage();
  const release = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  try {
    const first = descriptor("delayed", "Delayed site");
    const second = descriptor("current", "Current site");
    const state = await siteFixture(page, [first, second], [first.id, second.id]);
    await fixtureOperation(server, page, "site.open", async ({ siteId }, _context, next) => {
      const response = await next();
      if (siteId === first.id) {
        await release.promise;
        completed.resolve();
      }
      return response;
    });
    await page.goto(url);
    await page.getByRole("button", { name: "Sites", exact: true }).click();
    const switcher = page.getByRole("dialog", { name: "Sites" });
    await expect.poll(() => state.opened).toEqual([first.id]);
    await switcher.frameLocator("iframe").getByRole("heading", { name: first.name }).waitFor();
    const trigger = switcher.getByRole("button", { name: "Choose site", exact: true });
    await trigger.click();
    const choices = page.getByRole("list", { name: "Available sites" });
    await choices.getByRole("button", { name: second.name }).click();
    const heading = switcher.frameLocator("iframe").getByRole("heading", { name: second.name });
    await heading.waitFor();
    await expect.poll(() => state.opened).toEqual([first.id, second.id]);
    release.resolve();
    await completed.promise;
    await switcher.getByRole("button", { name: "Share site" }).click();
    const publicity = page.getByRole("switch", { name: "Public" });
    await publicity.click();
    await expect.poll(() => publicity.isChecked()).toBe(true);
    expect(state.saves).toEqual([[second.id, true]]);
    expect(await heading.isVisible()).toBe(true);
    expect(await switcher.locator(".full-popover__title").textContent()).toBe(second.name);
    expect(state.loaded).toEqual([first.id, second.id]);
  } finally {
    release.resolve();
    await page.close();
  }
}, 30_000);

test("Public remains usable when saving a recent visit fails", async () => {
  const page = await browser.newPage();
  try {
    const site = descriptor("recent-write-failure", "Visit still opens");
    const state = await siteFixture(page, [site], [site.id]);
    await fixtureOperation(server, page, "site.open", () => {
      throw new RpcError("INTERNAL", "History write failed");
    });
    await page.goto(url);
    await page.getByRole("button", { name: "Sites", exact: true }).click();
    const switcher = page.getByRole("dialog", { name: "Sites" });
    await switcher.getByRole("alert").filter({ hasText: "History write failed" }).waitFor();
    await switcher.frameLocator("iframe").getByRole("heading", { name: site.name }).waitFor();
    await switcher.getByRole("button", { name: "Share site" }).click();
    const publicity = page.getByRole("switch", { name: "Public" });
    await publicity.click();
    await expect.poll(() => publicity.isChecked()).toBe(true);
    await publicity.click();
    await expect.poll(() => publicity.isChecked()).toBe(false);
    expect(state.saves).toEqual([
      [site.id, true],
      [site.id, false],
    ]);
  } finally {
    await page.close();
  }
}, 30_000);
