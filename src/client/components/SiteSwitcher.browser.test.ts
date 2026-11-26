// @vitest-environment node
import path from "node:path";
import vue from "@vitejs/plugin-vue";
import { chromium, type Browser, type Page } from "patchright";
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
  let catalogCalls = 0;
  const opened: string[] = [];
  const loaded: string[] = [];
  const saves: [string, boolean][] = [];
  const catalog = () => ({
    sites: [
      ...recent.map((id) => sites.find((site) => site.id === id)!),
      ...sites.filter((site) => !recent.includes(site.id)),
    ],
    recentSiteIds: recent,
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
    return { value: { ...catalog(), site } };
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
    return route.fulfill({ contentType: "text/html", body: `<h1>${site.name}</h1>` });
  });
  return {
    add(site: SiteDescriptor) {
      sites = [...sites, site];
    },
    catalogCalls: () => catalogCalls,
    loaded,
    opened,
    saves,
  };
}

test("empty catalog and first chooser don't record a visit, but opening a chat site becomes the toolbar default", async () => {
  const page = await browser.newPage();
  try {
    const state = await siteFixture(page, [], []);
    await page.goto(url);
    const launcher = page.getByRole("button", { name: "Sites", exact: true });
    const switcher = page.getByRole("dialog", { name: "Sites", exact: true });
    const close = switcher.getByRole("button", { name: "Close sites" });
    const choices = switcher.getByRole("list", { name: "Available sites" });
    await launcher.click();
    await switcher.getByText("No sites yet.").waitFor();
    expect(await switcher.locator("iframe").count()).toBe(0);
    expect(state.opened).toEqual([]);
    await close.click();
    await switcher.waitFor({ state: "hidden" });

    state.add(descriptor("newest", "New unvisited site"));
    await launcher.click();
    await choices.waitFor();
    expect(
      (await choices.getByRole("button").allTextContents()).map((name) => name.trim()),
    ).toEqual(["New unvisited site"]);
    expect(await switcher.locator("iframe").count()).toBe(0);
    expect(state.opened).toEqual([]);
    await page.keyboard.press("Tab");
    const onlyChoice = choices.getByRole("button", { name: "New unvisited site" });
    if (!(await onlyChoice.evaluate((element) => element === document.activeElement)))
      await page.keyboard.press("Tab");
    expect(await onlyChoice.evaluate((element) => element === document.activeElement)).toBe(true);
    await page.keyboard.press("Enter");
    await expect
      .poll(() => close.evaluate((element) => element === document.activeElement))
      .toBe(true);
    await switcher
      .frameLocator("iframe")
      .getByRole("heading", { name: "New unvisited site" })
      .waitFor();
    await expect.poll(() => state.opened).toEqual(["newest"]);
    await close.click();
    await switcher.waitFor({ state: "hidden" });

    state.add(descriptor("attached", "Chat attachment"));
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
    expect(state.catalogCalls()).toBe(3);
  } finally {
    await page.close();
  }
}, 30_000);

test.each([
  { name: "desktop", width: 1280, height: 840, mobile: false },
  { name: "320px touch", width: 320, height: 660, mobile: true },
])(
  "uses one popover with measured recent tabs, overflow, and Public on $name",
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
      const state = await siteFixture(
        page,
        [...recent, neverOpened],
        recent.map((site) => site.id),
      );
      await page.goto(url);
      const activate = (target: ReturnType<Page["locator"]>) =>
        mobile ? target.tap() : target.click();
      const launcher = page.getByRole("button", { name: "Sites", exact: true });
      const switcher = page.getByRole("dialog", { name: "Sites", exact: true });
      const close = switcher.getByRole("button", { name: "Close sites" });
      const frame = switcher.frameLocator("iframe");
      const tabs = switcher.getByRole("tablist", { name: "Recent sites" });
      const more = tabs.getByRole("tab", { name: "More sites" });
      const first = tabs.getByRole("tab", { name: names[0], exact: true });
      await activate(launcher);
      await frame.getByRole("heading", { name: names[0] }).waitFor();
      await expect.poll(() => state.opened).toEqual([recent[0]!.id]);
      await first.waitFor();
      await more.waitFor();
      expect((await tabs.getByRole("tab").last().textContent())?.trim()).toBe("More sites");
      expect(await first.getAttribute("aria-selected")).toBe("true");
      expect(await switcher.locator("iframe").count()).toBe(1);
      expect(await switcher.locator("iframe").getAttribute("sandbox")).not.toContain(
        "allow-same-origin",
      );
      expect(await page.locator(":popover-open").count()).toBe(1);

      const tabNames = async () =>
        (await tabs.getByRole("tab").allTextContents()).map((name) => name.trim());
      const count = (await tabNames()).length;
      await page.setViewportSize({ width: mobile ? 1280 : 320, height });
      if (mobile) await expect.poll(async () => (await tabNames()).length).toBeGreaterThan(count);
      else await expect.poll(async () => (await tabNames()).length).toBeLessThan(count);
      await page.setViewportSize({ width, height });
      await expect.poll(async () => (await tabNames()).length).toBe(count);
      expect(state.loaded).toEqual([recent[0]!.id]);

      if (mobile) await activate(more);
      else {
        await first.focus();
        await page.keyboard.press("End");
        expect(await more.evaluate((element) => element === document.activeElement)).toBe(true);
        expect(await first.getAttribute("aria-selected")).toBe("true");
        await page.keyboard.press("Enter");
      }
      const choices = switcher.getByRole("list", { name: "Available sites" });
      await choices.waitFor();
      expect(await more.getAttribute("aria-selected")).toBe("true");
      expect(await switcher.locator("iframe").isVisible()).toBe(false);
      const visible = await tabNames();
      const remaining = [...recent, neverOpened].filter((site) => !visible.includes(site.name));
      expect(
        (await choices.getByRole("button").allTextContents()).map((name) => name.trim()),
      ).toEqual(remaining.map((site) => site.name));
      expect(state.opened).toEqual([recent[0]!.id]);

      await activate(first);
      await frame.getByRole("heading", { name: names[0] }).waitFor();
      expect(state.loaded).toEqual([recent[0]!.id]);
      expect(state.opened).toEqual([recent[0]!.id]);
      await activate(more);
      await activate(choices.getByRole("button", { name: neverOpened.name }));
      await frame.getByRole("heading", { name: neverOpened.name }).waitFor();
      await expect.poll(() => state.opened).toEqual([recent[0]!.id, neverOpened.id]);
      const current = tabs.getByRole("tab", { name: neverOpened.name });
      expect(await current.getAttribute("aria-selected")).toBe("true");

      const publicity = switcher.getByRole("switch", { name: "Public" });
      await activate(publicity);
      await expect.poll(() => publicity.isChecked()).toBe(true);
      expect(state.saves).toEqual([[neverOpened.id, true]]);
      await activate(close);
      await switcher.waitFor({ state: "hidden" });
      await page.reload();
      await activate(launcher);
      await frame.getByRole("heading", { name: neverOpened.name }).waitFor();
      await expect.poll(() => publicity.isChecked()).toBe(true);
      await activate(publicity);
      await expect.poll(() => publicity.isChecked()).toBe(false);
      expect(state.saves).toEqual([
        [neverOpened.id, true],
        [neverOpened.id, false],
      ]);
      expect(state.catalogCalls()).toBe(2);
      expect(state.opened).toEqual([recent[0]!.id, neverOpened.id, neverOpened.id]);
      if (process.env.BATTY_SITE_SWITCHER_SCREENSHOTS)
        await page.screenshot({
          path: `${process.env.BATTY_SITE_SWITCHER_SCREENSHOTS}/${mobile ? "mobile" : "desktop"}.png`,
        });
      await activate(close);
      await switcher.waitFor({ state: "hidden" });
      expect(await launcher.evaluate((element) => element === document.activeElement)).toBe(true);
    } finally {
      await context.close();
    }
  },
  30_000,
);

test("resize preserves focus if a tab or More choice stops fitting", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    const sites = names.slice(0, 4).map((name, i) => descriptor(`small-set-${i}`, name));
    const state = await siteFixture(
      page,
      sites,
      sites.map((site) => site.id),
    );
    await page.goto(url);
    await page.getByRole("button", { name: "Sites", exact: true }).click();
    const switcher = page.getByRole("dialog", { name: "Sites" });
    const tabs = switcher.getByRole("tablist", { name: "Recent sites" });
    const first = tabs.getByRole("tab", { name: names[0] });
    const last = tabs.getByRole("tab", { name: names[3] });
    const more = tabs.getByRole("tab", { name: "More sites" });
    await last.waitFor();
    await more.waitFor({ state: "hidden" });
    await last.focus();
    await page.setViewportSize({ width: 320, height: 800 });
    await last.waitFor({ state: "detached" });
    await expect
      .poll(() => more.evaluate((element) => element === document.activeElement))
      .toBe(true);
    await page.keyboard.press("Enter");
    const choice = switcher.getByRole("button", { name: names[3] });
    await choice.waitFor();
    await choice.focus();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect
      .poll(() => first.evaluate((element) => element === document.activeElement))
      .toBe(true);
    await more.waitFor({ state: "hidden" });
    await switcher.frameLocator("iframe").getByRole("heading", { name: names[0] }).waitFor();
    expect(state.opened).toEqual([sites[0]!.id]);
    expect(state.loaded).toEqual([sites[0]!.id]);
  } finally {
    await page.close();
  }
}, 30_000);

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
    await switcher.getByRole("tab", { name: second.name }).click();
    const heading = switcher.frameLocator("iframe").getByRole("heading", { name: second.name });
    await heading.waitFor();
    await expect.poll(() => state.opened).toEqual([first.id, second.id]);
    release.resolve();
    await completed.promise;
    const publicity = switcher.getByRole("switch", { name: "Public" });
    await publicity.click();
    await expect.poll(() => publicity.isChecked()).toBe(true);
    expect(state.saves).toEqual([[second.id, true]]);
    expect(await heading.isVisible()).toBe(true);
    expect(
      await switcher.getByRole("tab", { name: second.name }).getAttribute("aria-selected"),
    ).toBe("true");
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
    const publicity = switcher.getByRole("switch", { name: "Public" });
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
