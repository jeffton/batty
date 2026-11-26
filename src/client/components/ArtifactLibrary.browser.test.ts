// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import vue from "@vitejs/plugin-vue";
import { chromium, type Browser } from "patchright";
import sharp from "sharp";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { artifactTextUrl, type ArtifactLibraryItem } from "@/shared/artifact-library";
import { closeBrowserFixtureServer, createBrowserFixtureServer } from "../test/browser-fixture";
import type { SiteDescriptor } from "@/shared/types";
import type { Runtime } from "@/server/runtime";
import { createOwnerRpcHandler, type OwnerRpcServices } from "@/server/owner-rpc";
import { createSite, getSite } from "@/server/sites";
import { fixtureOperation, setFixtureRpcHandler } from "../test/socket-fixture";

const fixture = "src/client/components/ArtifactLibrary.fixture.html";
const base = "/nested/app";
const incomingName = "Incoming photo.jpg";
const outgoingName = "Generated-photo-with-a-long-unbroken-filename-".repeat(3) + ".jpg";
const longName = "Detail-with-a-long-unbroken-filename-".repeat(4) + ".bin";
const bytes = Buffer.of(0, 82, 255, 4);
const artifactListUrl = /\/nested\/app\/api\/artifacts\?limit=\d+$/;
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
): Extract<ArtifactLibraryItem, { kind: "file" }> {
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
      mimeType: image ? "image/jpeg" : "application/octet-stream",
      size: image ? photoBytes.byteLength : bytes.byteLength,
      downloadUrl: `${url}?download=1`,
      previewUrl: image ? url : undefined,
    },
  };
}

function fixtureArtifacts(site: SiteDescriptor): ArtifactLibraryItem[] {
  return [
    file("sent-photo", outgoingName, "2026-11-26T07:00:00Z", "generated", true),
    {
      ref: `site:${site.id}`,
      title: siteName,
      kind: "site",
      starred: true,
      createdAt: "2026-11-25T12:00:00Z",
      site: { ...site, url: `/old/sites/${site.id}/` },
    },
    file("report", longName, "2026-11-26T09:00:00Z", "generated", false),
    file("uploaded-photo", incomingName, "2026-11-26T08:00:00Z", "upload", true),
  ];
}

function orderedArtifacts(items: ArtifactLibraryItem[]) {
  return items.toSorted(
    (a, b) => Number(b.starred) - Number(a.starred) || b.createdAt.localeCompare(a.createdAt),
  );
}

let server: ViteDevServer;
let browser: Browser;
let origin: string;
let sitesDir: string;

beforeAll(async () => {
  sitesDir = await fs.mkdtemp(path.join(os.tmpdir(), "batty-artifact-library-sites-"));
  server = await createBrowserFixtureServer(fixture, {
    plugins: [vue()],
    define: { __BATTY_BUILD_ID__: JSON.stringify("dev") },
    resolve: { alias: { "@": path.resolve("src") } },
    server: { host: "127.0.0.1", port: 0 },
  });
  setFixtureRpcHandler(
    server,
    createOwnerRpcHandler(
      { config: { sitesDir, baseUrl: base }, tools: {} } as unknown as Runtime,
      {} as OwnerRpcServices,
    ),
  );
  await server.listen();
  origin = server.resolvedUrls!.local[0]!;
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  if (server) await closeBrowserFixtureServer(server);
  if (sitesDir) await fs.rm(sitesDir, { recursive: true, force: true });
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
      const { descriptor } = await createSite(sitesDir, base, siteName);
      const items = fixtureArtifacts(descriptor);
      const errors: string[] = [];
      const starWrites: { ref: string; starred: boolean; limit: number }[] = [];
      let libraryReads = 0;
      let siteVisits = 0;
      let visibilityReads = 0;
      await fixtureOperation(server, page, "site.get", async (input, _context, next) => {
        expect(input).toEqual({ siteId: descriptor.id });
        const response = await next();
        visibilityReads++;
        return response;
      });
      const persistedVisibility = async () =>
        (await getSite(sitesDir, base, descriptor.id)).descriptor.public;
      let rejectStar = true;
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route(artifactListUrl, async (route) => {
        libraryReads++;
        await route.fulfill({ json: { artifacts: orderedArtifacts(items) } });
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
        await route.fulfill({ json: { artifacts: orderedArtifacts(items) } });
      });
      for (const item of items) {
        if (item.kind !== "file") continue;
        await page.route(`${origin.slice(0, -1)}${item.file.downloadUrl}`, (route) =>
          route.fulfill({
            body: item.file.kind === "image" ? photoBytes : bytes,
            contentType: item.file.mimeType,
          }),
        );
        if (item.file.previewUrl)
          await page.route(`**${item.file.previewUrl}`, (route) =>
            route.fulfill({ body: photoBytes, contentType: item.file.mimeType }),
          );
      }
      await page.route(`**${base}/sites/${descriptor.id}/**`, (route) =>
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
      const starBackground = () =>
        star.evaluate((element) => getComputedStyle(element).backgroundColor);
      if (!mobile) {
        await star.hover();
        await expect.poll(starBackground).not.toBe("rgba(0, 0, 0, 0)");
        await library.getByRole("button", { name: "Close artifacts" }).hover();
      }
      await expect.poll(starBackground).toBe("rgba(0, 0, 0, 0)");
      expect(
        await star.locator("svg").evaluate((element) => {
          const style = getComputedStyle(element);
          return style.fill === style.color;
        }),
      ).toBe(true);
      await star.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      expect(
        await star.evaluate(
          (element) =>
            element.matches(":focus-visible") && getComputedStyle(element).outlineStyle === "solid",
        ),
      ).toBe(true);
      expect(starWrites).toEqual([
        { ref: "file:sent-photo", starred: true, limit: expect.any(Number) },
        { ref: "file:sent-photo", starred: true, limit: expect.any(Number) },
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
      expect(await buffer(await (await plainDownload).createReadStream())).toEqual(bytes);

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
        const publicity = site.getByRole("switch", { name: "Public" });
        await publicity.waitFor();
        await expect.poll(() => visibilityReads).toBe(visit);
        if (mobile && visit === 1) {
          expect(await publicity.isChecked()).toBe(false);
          await click(site.getByText("Public", { exact: true }));
          await expect.poll(() => publicity.isChecked()).toBe(true);
          await expect.poll(persistedVisibility).toBe(true);
        } else if (mobile) {
          expect(await publicity.isChecked()).toBe(true);
          await click(site.getByText("Public", { exact: true }));
          await expect.poll(() => publicity.isChecked()).toBe(false);
          await expect.poll(persistedVisibility).toBe(false);
        }
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

test.each([
  { name: "desktop", width: 1280, height: 840, mobile: false },
  { name: "mobile touch", width: 320, height: 660, mobile: true },
])(
  "previews and downloads uploaded and generated text on $name",
  async ({ name, width, height, mobile }) => {
    const context = await browser.newContext({
      viewport: { width, height },
      isMobile: mobile,
      hasTouch: mobile,
      colorScheme: mobile ? "dark" : "light",
    });
    await context.addCookies([{ name: "fixture-auth", value: "ok", url: origin }]);
    const page = await context.newPage();
    page.setDefaultTimeout(8_000);
    const open = (target: ReturnType<typeof page.locator>) =>
      mobile ? target.tap() : target.click();
    const generated =
      'export const status: string = "' + "all systems operational ".repeat(25) + '";';
    const uploaded = [
      "[INFO] Télémetry active 🦾",
      "<script>window.previewExecuted = true</script>",
    ].join("\n");
    const samples = [
      {
        name: "server.log",
        source: "upload",
        text: uploaded + "\n" + "[DEBUG] Full log continues here.\n".repeat(2500),
        preview: uploaded,
        mime: "text/plain",
      },
      {
        name: "instrumentation.ts",
        source: "generated",
        text: generated,
        preview: generated,
        mime: "text/typescript",
      },
    ] as const;
    const items = samples.map((sample, index) => {
      const item = file(
        sample.name,
        sample.name,
        `2026-11-26T09:00:0${index}Z`,
        sample.source,
        false,
      );
      item.file.mimeType = sample.mime;
      item.file.size = Buffer.byteLength(sample.text);
      return {
        ...item,
        textPreviewUrl: artifactTextUrl(item.file.downloadUrl),
      };
    });
    const authenticatedRequests: string[] = [];
    try {
      await page.route(artifactListUrl, (route) =>
        route.fulfill({ json: { artifacts: orderedArtifacts(items) } }),
      );
      let rejectUpload = true;
      for (const [index, item] of items.entries()) {
        const sample = samples[index]!;
        await page.route(new URL(item.textPreviewUrl, origin).href, (route) => {
          expect(route.request().headers().cookie).toContain("fixture-auth=ok");
          authenticatedRequests.push("preview:" + sample.name);
          if (sample.source === "upload" && rejectUpload)
            return route.fulfill({ status: 415, json: { error: "Text preview unavailable" } });
          return route.fulfill({
            body: sample.preview,
            contentType: "text/plain; charset=utf-8",
            headers: sample.source === "upload" ? { "X-Batty-Preview-Truncated": "1" } : {},
          });
        });
        await page.route(new URL(item.file.downloadUrl, origin).href, (route) => {
          expect(route.request().headers().cookie).toContain("fixture-auth=ok");
          authenticatedRequests.push("download:" + sample.name);
          return route.fulfill({ body: sample.text, contentType: sample.mime });
        });
      }
      await page.goto(origin + fixture);
      await open(page.getByRole("button", { name: "Artifacts", exact: true }));
      const library = page.getByRole("dialog", { name: "Artifacts" });
      await library.getByRole("list", { name: "Artifacts" }).waitFor();
      expect(authenticatedRequests).toEqual([]);

      const upload = library.getByRole("button", { name: /^server\.log/ });
      await open(upload);
      const uploadDialog = page.getByRole("dialog", { name: "server.log" });
      const uploadError = uploadDialog.getByRole("alert");
      await uploadError.waitFor();
      expect(await uploadError.textContent()).toContain("Text preview unavailable");
      await open(uploadDialog.getByRole("button", { name: "Close file preview" }));
      rejectUpload = false;

      for (const sample of samples) {
        const title = library.getByRole("button", { name: new RegExp(`^${sample.name}`) });
        await open(title);
        const preview = page.getByRole("dialog", { name: sample.name });
        const region = preview.getByRole("region", { name: "File preview" });
        const lines = region.locator("[data-line]");
        await lines.first().waitFor();
        expect(await lines.allTextContents()).toEqual(sample.preview.split("\n"));
        expect(await region.locator("script").count()).toBe(0);
        const truncated = preview.getByRole("status").filter({ hasText: "Preview truncated." });
        expect(await truncated.isVisible()).toBe(sample.source === "upload");
        if (sample.source === "generated") {
          await expect.poll(() => lines.first().locator("span").count()).toBeGreaterThan(1);
          const wrap = preview.getByRole("button", { name: "Wrap lines" });
          const lineHeight = () =>
            lines.first().evaluate((line) => line.getBoundingClientRect().height);
          const wrappedHeight = await lineHeight();
          expect(await wrap.getAttribute("aria-pressed")).toBe("true");
          await open(wrap);
          expect(await wrap.getAttribute("aria-pressed")).toBe("false");
          await expect.poll(lineHeight).toBeLessThan(wrappedHeight);
          const code = region.locator("[data-overflow='scroll'] > [data-code]");
          await code.waitFor();
          expect(await code.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
          await open(wrap);
          await expect.poll(lineHeight).toBe(wrappedHeight);
        }
        if (process.env.BATTY_ARTIFACT_TEXT_SCREENSHOTS) {
          await page.screenshot({
            path: `${process.env.BATTY_ARTIFACT_TEXT_SCREENSHOTS}/${name.replaceAll(" ", "-")}-${sample.name}.png`,
          });
        }
        const download = page.waitForEvent("download");
        await open(preview.getByRole("link", { name: "Download file" }));
        const result = await download;
        expect(result.suggestedFilename()).toBe(sample.name);
        expect(await buffer(await result.createReadStream())).toEqual(Buffer.from(sample.text));
        await open(preview.getByRole("button", { name: "Close file preview" }));
        await preview.waitFor({ state: "hidden" });
        expect(await library.isVisible()).toBe(true);
      }
      expect(authenticatedRequests).toEqual([
        "preview:server.log",
        "preview:server.log",
        "download:server.log",
        "preview:instrumentation.ts",
        "download:instrumentation.ts",
      ]);
      expect(page.url()).toBe(origin + fixture);
      expect(context.pages()).toHaveLength(1);
    } finally {
      await context.close();
    }
  },
  30_000,
);
