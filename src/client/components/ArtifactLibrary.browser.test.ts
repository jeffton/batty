// @vitest-environment node
import path from "node:path";
import { buffer } from "node:stream/consumers";
import vue from "@vitejs/plugin-vue";
import { chromium, type Browser } from "patchright";
import sharp from "sharp";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import type { ArtifactLibraryItem } from "@/shared/artifact-library";
import { closeBrowserFixtureServer, createBrowserFixtureServer } from "../test/browser-fixture";

const fixture = "src/client/components/ArtifactLibrary.fixture.html";
const base = "/nested/app";
const incomingName = "Incoming photo.jpg";
const outgoingName = "Generated-photo-with-a-long-unbroken-filename-".repeat(3) + ".jpg";
const longName = "Detail-with-a-long-unbroken-filename-".repeat(4) + ".txt";
const siteName = "View from the cabin";
const photoBytes = await sharp({
  create: { width: 120, height: 80, channels: 3, background: "#008080" },
})
  .jpeg()
  .toBuffer();

function file(
  id: string,
  name: string,
  createdAt: string,
  source: "upload" | "generated",
  image: boolean,
): ArtifactLibraryItem {
  const url = `${base}/api/${source === "upload" ? "uploads" : "sent-files"}/${id}`;
  return {
    ref: `file:${id}`,
    title: name,
    createdAt,
    starred: false,
    kind: "file",
    source,
    file: {
      id,
      name,
      kind: image ? "image" : "file",
      mimeType: image ? "image/jpeg" : "text/plain",
      size: image ? photoBytes.byteLength : 4,
      downloadUrl: `${url}?download=1`,
      previewUrl: image ? url : undefined,
    },
  };
}

function fixtureArtifacts(): ArtifactLibraryItem[] {
  return [
    file("sent-photo", outgoingName, "2026-11-26T07:00:00Z", "generated", true),
    {
      ref: "site:cabin",
      title: siteName,
      kind: "site",
      starred: true,
      createdAt: "2026-11-25T12:00:00Z",
      site: { id: "cabin", name: siteName, kind: "site", public: false, url: "/old/sites/cabin/" },
    },
    file("report", longName, "2026-11-26T09:00:00Z", "generated", false),
    file("uploaded-photo", incomingName, "2026-11-26T08:00:00Z", "upload", true),
  ];
}

let server: ViteDevServer;
let browser: Browser;
let origin: string;
beforeAll(async () => {
  server = await createBrowserFixtureServer(fixture, {
    plugins: [vue()],
    define: { __BATTY_BUILD_ID__: JSON.stringify("dev") },
    resolve: { alias: { "@": path.resolve("src") } },
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  origin = server.resolvedUrls!.local[0]!;
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  if (server) await closeBrowserFixtureServer(server);
});

test.each([
  { name: "desktop", width: 1280, height: 840, mobile: false },
  { name: "mobile touch", width: 320, height: 660, mobile: true },
])(
  "opens and navigates the artifact library on $name",
  async ({ width, height, mobile }) => {
    const context = await browser.newContext({
      viewport: { width, height },
      isMobile: mobile,
      hasTouch: mobile,
      colorScheme: mobile ? "dark" : "light",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8_000);
    try {
      const items = fixtureArtifacts();
      const errors: string[] = [];
      const starWrites: { ref: string; starred: boolean }[] = [];
      let libraryReads = 0;
      let siteVisits = 0;
      let rejectStar = true;
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route(`**${base}/api/artifacts`, async (route) => {
        libraryReads++;
        await route.fulfill({ json: { artifacts: items } });
      });
      await page.route(`**${base}/api/artifacts/star`, async (route) => {
        const request = route.request();
        expect(request.method()).toBe("PUT");
        const write = request.postDataJSON();
        starWrites.push(write);
        if (rejectStar) {
          await route.fulfill({ status: 503, json: { error: "Busy" } });
          return;
        }
        items.find((item) => item.ref === write.ref)!.starred = write.starred;
        await route.fulfill({ json: { artifacts: items } });
      });
      for (const item of items) {
        if (item.kind !== "file") continue;
        await page.route(`${origin.slice(0, -1)}${item.file.downloadUrl}`, (route) =>
          route.fulfill({
            body: item.file.kind === "image" ? photoBytes : "text",
            contentType: item.file.mimeType,
          }),
        );
        if (item.file.previewUrl)
          await page.route(`**${item.file.previewUrl}`, (route) =>
            route.fulfill({ body: photoBytes, contentType: item.file.mimeType }),
          );
      }
      await page.route(`**${base}/sites/cabin/**`, (route) =>
        route.fulfill({ contentType: "text/html", body: `<h1>Version ${++siteVisits}</h1>` }),
      );

      const click = (locator: ReturnType<typeof page.locator>) =>
        mobile ? locator.tap() : locator.click();
      await page.goto(origin + fixture);
      const launcher = page.getByRole("button", { name: "Artifacts", exact: true });
      await launcher.waitFor();
      expect(libraryReads).toBe(0);
      expect(siteVisits).toBe(0);
      await click(launcher);
      const library = page.getByRole("dialog", { name: "Artifacts" });
      const list = library.getByRole("list", { name: "Artifacts" });
      await list.waitFor();
      expect((await library.boundingBox())!.width).toBeGreaterThan(width - 50);
      expect((await library.boundingBox())!.height).toBeGreaterThan(height - 50);
      expect(await list.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      const titles = () => list.locator("strong").allTextContents();
      expect(await titles()).toEqual([siteName, longName, incomingName, outgoingName]);

      const star = list.getByRole("button", { name: `Star ${outgoingName}` });
      await click(star);
      const failure = library.getByRole("alert");
      await failure.waitFor();
      expect(await failure.textContent()).toContain("HTTP 503");
      expect(await star.getAttribute("aria-pressed")).toBe("false");

      rejectStar = false;
      await click(star);
      await expect.poll(() => titles()).toEqual([outgoingName, siteName, longName, incomingName]);
      expect(await star.getAttribute("aria-pressed")).toBe("true");
      expect(await star.evaluate((element) => element === document.activeElement)).toBe(true);
      expect(starWrites).toEqual([
        { ref: "file:sent-photo", starred: true },
        { ref: "file:sent-photo", starred: true },
      ]);

      await page.reload();
      await click(launcher);
      await list.waitFor();
      expect(await titles()).toEqual([outgoingName, siteName, longName, incomingName]);
      await click(star);
      await expect.poll(() => titles()).toEqual([siteName, longName, incomingName, outgoingName]);

      for (const name of [incomingName, outgoingName]) {
        const trigger = list.getByRole("button", { name: new RegExp(`^${name}`) });
        await click(trigger);
        const image = page.getByRole("dialog", { name });
        await image.locator("img").evaluate((element: HTMLImageElement) => element.decode());
        if (mobile && name === outgoingName) {
          const title = image.locator(".full-popover__title");
          expect(await title.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
            true,
          );
          const titleBox = (await title.boundingBox())!;
          const controls = (await image.locator(".full-popover__header-actions").boundingBox())!;
          expect(titleBox.x + titleBox.width).toBeLessThan(controls.x);
        }
        const closeImage = image.getByRole("button", { name: "Close image" });
        const downloadEvent = page.waitForEvent("download");
        await click(image.getByRole("link", { name: "Download image" }));
        const download = await downloadEvent;
        expect(download.suggestedFilename()).toBe(name);
        expect(await buffer(await download.createReadStream())).toEqual(photoBytes);
        await click(closeImage);
        await image.waitFor({ state: "hidden" });
        expect(await library.isVisible()).toBe(true);
      }

      const plainDownload = page.waitForEvent("download");
      await click(list.getByRole("link", { name: `Download ${longName}` }));
      expect(await buffer(await (await plainDownload).createReadStream())).toEqual(
        Buffer.from("text"),
      );

      expect(siteVisits).toBe(0);
      const openSite = list.getByRole("button", { name: new RegExp(`^${siteName}`) });
      const site = page.getByRole("dialog", { name: siteName });
      const frame = site.frameLocator("iframe");
      for (const visit of [1, 2]) {
        await click(openSite);
        await frame.getByRole("heading", { name: `Version ${visit}` }).waitFor();
        expect(await site.locator("iframe").getAttribute("sandbox")).not.toContain(
          "allow-same-origin",
        );
        await click(site.getByRole("button", { name: "Close site" }));
        await site.locator("iframe").waitFor({ state: "detached" });
        expect(await library.isVisible()).toBe(true);
      }
      await click(library.getByRole("button", { name: "Close artifacts" }));
      expect(await library.isVisible()).toBe(false);
      expect(await launcher.evaluate((element) => element === document.activeElement)).toBe(true);
      expect(libraryReads).toBe(2);
      expect(errors).toEqual([]);
      expect(context.pages()).toHaveLength(1);
    } finally {
      await context.close();
    }
  },
  30_000,
);
