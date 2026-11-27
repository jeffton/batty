// @vitest-environment node
import { buffer } from "node:stream/consumers";
import path from "node:path";
import fastify from "fastify";
import vue from "@vitejs/plugin-vue";
import { chromium } from "patchright";
import type { Browser } from "playwright-core";
import sharp from "sharp";
import { expect, test } from "vite-plus/test";
import { closeBrowserFixtureServer, createBrowserFixtureServer } from "../test/browser-fixture";

test("chromium: attachment popover zooms without navigation and downloads authenticated bytes", async () => {
  const original = await sharp({
    create: { width: 320, height: 240, channels: 3, background: "#008080" },
  })
    .jpeg()
    .toBuffer();
  const route =
    "/api/sent-files/roy/517235/" +
    encodeURIComponent("call_" + "a".repeat(98) + "/codemode-2") +
    "/old-image";
  const requests: { search: string; authenticated: boolean }[] = [];
  const backend = fastify({ forceCloseConnections: true });
  let downloadAvailable = false;
  backend.get("/api/sent-files/*", (request, reply) => {
    const url = new URL(request.url, "http://localhost");
    const authenticated = request.headers.cookie?.includes("attachment-auth=test") ?? false;
    requests.push({ search: url.search, authenticated });
    if (!authenticated) return reply.code(401).send();
    if (url.searchParams.has("download")) {
      if (!downloadAvailable) return reply.code(404).send();
      reply.header("content-disposition", "attachment; filename=Cabin.jpg");
    }
    return reply.type("image/jpeg").send(original);
  });
  const target = await backend.listen({ host: "127.0.0.1", port: 0 });
  const server = await createBrowserFixtureServer(
    "src/client/components/AttachedFilesList.fixture.html",
    {
      plugins: [vue()],
      resolve: { alias: { "@": path.resolve("src") } },
      server: { host: "127.0.0.1", port: 0, proxy: { "/api": { target } } },
    },
  );
  await server.listen();
  const origin = server.resolvedUrls!.local[0]!;
  const browser = (await chromium.launch({ headless: true })) as unknown as Browser;
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  await context.addCookies([{ name: "attachment-auth", value: "test", url: origin }]);
  const page = await context.newPage();
  try {
    const url =
      origin +
      "src/client/components/AttachedFilesList.fixture.html?original=" +
      encodeURIComponent(route);
    await page.goto(url);
    const trigger = page.getByRole("button", { name: "Open original: Cabin.jpg" });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Cabin.jpg" });
    await expect.poll(() => dialog.isVisible()).toBe(true);
    await dialog.locator("img").evaluate((image: HTMLImageElement) => image.decode());
    expect(
      await dialog.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth),
    ).toBe(320);
    await dialog.getByRole("button", { name: "Zoom in", exact: true }).click();
    expect(
      await dialog.locator("img").evaluate((image) => getComputedStyle(image).transform),
    ).toContain("1.5");
    const keyboardSurface = dialog.getByRole("region", { name: /Image viewer/ });
    await keyboardSurface.focus();
    await page.keyboard.press("ArrowRight");
    expect(await dialog.locator("img").evaluate((image) => getComputedStyle(image).transform)).toBe(
      "matrix(1.5, 0, 0, 1.5, -40, 0)",
    );
    await dialog.getByRole("button", { name: "Reset zoom" }).click();

    // Two captured touch pointers pinch around their midpoint; one remaining finger pans.
    const surface = dialog.locator(".image-viewer");
    const cdp = await context.newCDPSession(page);
    const point = (id: number, x: number, y: number) => ({ id, x, y });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [point(1, 150, 300)],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [point(1, 150, 300), point(2, 250, 300)],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [point(1, 100, 300), point(2, 300, 300)],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [point(1, 100, 300)],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [point(1, 120, 330)],
    });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    await cdp.detach();
    expect(
      await dialog.locator("img").evaluate((image) => getComputedStyle(image).transform),
    ).toMatch(/^matrix\(2, 0, 0, 2,/);
    expect(await surface.evaluate((element) => getComputedStyle(element).touchAction)).toBe("none");
    await dialog.getByRole("button", { name: "Close image" }).click();
    await expect.poll(() => dialog.isVisible()).toBe(false);
    expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(true);
    await trigger.click();
    await expect.poll(() => dialog.isVisible()).toBe(true);
    expect(await dialog.locator("img").evaluate((image) => getComputedStyle(image).transform)).toBe(
      "matrix(1, 0, 0, 1, 0, 0)",
    );
    await page.keyboard.press("Escape");
    await expect.poll(() => dialog.isVisible()).toBe(false);

    const downloadLink = page.getByRole("link", { name: "Download", exact: true });
    await downloadLink.click();
    const downloadError = page.getByRole("alert");
    await downloadError.waitFor();
    expect(await downloadError.textContent()).toContain("HTTP 404");

    downloadAvailable = true;
    const downloadPromise = page.waitForEvent("download");
    await downloadLink.click();
    const download = await downloadPromise;
    await downloadError.waitFor({ state: "hidden" });
    expect(download.url()).toMatch(/^blob:/);
    expect(download.suggestedFilename()).toBe("Cabin.jpg");
    expect(await buffer(await download.createReadStream())).toEqual(original);
    expect(requests.some((request) => request.search === "?download=1")).toBe(true);
    expect(requests.every((request) => request.authenticated)).toBe(true);
    expect(page.url()).toBe(url);
    expect(context.pages()).toHaveLength(1);

    // SVG is displayed only through the raster preview endpoint, never as an active document.
    requests.length = 0;
    await page.goto(url + "&mime=image%2Fsvg%2Bxml");
    await trigger.click();
    await dialog.locator("img").evaluate((image: HTMLImageElement) => image.decode());
    expect(await dialog.locator("img").getAttribute("src")).toBe(route + "?preview=1");
    expect(requests.every((request) => request.search === "?preview=1")).toBe(true);
    expect(context.pages()).toHaveLength(1);
  } finally {
    await browser.close();
    await closeBrowserFixtureServer(server);
    await backend.close();
  }
}, 30_000);

test.each([
  { name: "desktop", width: 1280, height: 840, touch: false },
  { name: "mobile", width: 320, height: 660, touch: true },
])(
  "chromium: text in user, assistant and worker attachments previews and downloads on $name",
  async ({ width, height, touch }) => {
    const fixture = "src/client/components/TextAttachmentMessages.fixture.html";
    const server = await createBrowserFixtureServer(fixture, {
      plugins: [vue()],
      resolve: { alias: { "@": path.resolve("src") } },
      server: { host: "127.0.0.1", port: 0 },
    });
    await server.listen();
    const origin = server.resolvedUrls!.local[0]!;
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({
        viewport: { width, height },
        hasTouch: touch,
        isMobile: touch,
      });
      const page = await context.newPage();
      const activate = (target: ReturnType<typeof page.locator>) =>
        touch ? target.tap() : target.click();
      const previewRequests: string[] = [];
      const samples = [
        {
          path: "/api/uploads/1/batch/upload.log",
          name: "upload.log",
          text: "[debug] Warm start 🦾",
          tail: "\n[DEBUG] More lines beyond the preview boundary".repeat(2000),
          source: "user",
        },
        {
          path: "/api/sent-files/work/2/tool/report",
          name: "report.txt",
          text: "Saved the report",
          source: "custom",
        },
        {
          path: "/api/sent-files/work/2/tool/binary",
          name: "binary.log",
          bytes: Buffer.of(0, 20, 255),
          source: "custom",
        },
        {
          path: "/api/sent-files/work/1/tool/output",
          name: "output.ts",
          text: `export const message = "${"A long highlighted line ".repeat(15)}${"anUnbrokenIdentifier".repeat(8)}";`,
          source: "assistant",
        },
      ];
      for (const sample of samples) {
        await page.route(new URL(sample.path, origin).href + "?text=1", (route) => {
          previewRequests.push(sample.name);
          if (sample.bytes)
            return route.fulfill({
              status: 415,
              json: { error: "This file is not UTF-8 text." },
            });
          return route.fulfill({
            body: sample.text,
            contentType: "text/plain; charset=utf-8",
            headers: sample.tail ? { "X-Batty-Preview-Truncated": "1" } : {},
          });
        });
        await page.route(new URL(sample.path, origin).href + "?download=1", (route) =>
          route.fulfill({
            body: sample.bytes ?? sample.text + (sample.tail ?? ""),
            contentType: "text/plain",
          }),
        );
      }
      await page.goto(origin + fixture);
      expect(previewRequests).toEqual([]);
      for (const sample of samples) {
        const card = page.locator(`.message--${sample.source} .attached-files__card`).filter({
          has: page.getByText(sample.name, { exact: true }),
        });
        const trigger = card.getByRole("button", { name: `Preview ${sample.name}` });
        await activate(trigger);
        const preview = page.getByRole("dialog", { name: sample.name, exact: true });
        if (sample.bytes) {
          const alert = preview.getByRole("alert");
          await alert.waitFor();
          expect(await alert.textContent()).toContain("This file is not UTF-8 text.");
        } else {
          const line = preview.locator("[data-line]");
          await line.waitFor();
          expect(await line.textContent()).toBe(sample.text);
          expect(
            await preview.getByText("Preview truncated. Download the full file.").isVisible(),
          ).toBe(Boolean(sample.tail));
          if (sample.source === "assistant") {
            await expect.poll(() => line.locator("span").count()).toBeGreaterThan(1);
            expect(
              await line.evaluate((element) => ({
                wraps:
                  element.getBoundingClientRect().height >
                  parseFloat(getComputedStyle(element).lineHeight),
                fits: element.scrollWidth === element.clientWidth,
              })),
            ).toEqual({ wraps: true, fits: true });
            expect(await preview.getByRole("button", { name: "Wrap lines" }).count()).toBe(0);
          }
        }
        const downloadLink = preview.getByRole("link", { name: "Download file" });
        const closeButton = preview.getByRole("button", { name: "Close file preview" });
        const { width: buttonWidth, height: buttonHeight } = (await closeButton.boundingBox())!;
        expect(await downloadLink.boundingBox()).toMatchObject({
          width: buttonWidth,
          height: buttonHeight,
        });
        if (!touch) {
          await closeButton.focus();
          await page.keyboard.press("Shift+Tab");
          expect(await downloadLink.evaluate((element) => element.matches(":focus-visible"))).toBe(
            true,
          );
        }
        const [result] = await Promise.all([
          page.waitForEvent("download"),
          touch ? activate(downloadLink) : page.keyboard.press("Enter"),
        ]);
        expect(result.suggestedFilename()).toBe(sample.name);
        expect(await buffer(await result.createReadStream())).toEqual(
          sample.bytes ?? Buffer.from(sample.text + (sample.tail ?? "")),
        );
        await activate(closeButton);
        await preview.waitFor({ state: "hidden" });
        expect(await card.getByRole("link", { name: "Download", exact: true }).isVisible()).toBe(
          true,
        );
      }
      expect(previewRequests).toEqual(samples.map((sample) => sample.name));
      expect(page.url()).toBe(origin + fixture);
    } finally {
      await browser.close();
      await closeBrowserFixtureServer(server);
    }
  },
  30_000,
);
