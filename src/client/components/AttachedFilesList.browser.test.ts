// @vitest-environment node
import fs from "node:fs/promises";
import path from "node:path";
import fastify from "fastify";
import vue from "@vitejs/plugin-vue";
import { chromium } from "patchright";
import { webkit, type Browser } from "playwright-core";
import sharp from "sharp";
import { expect, test } from "vite-plus/test";
import { closeBrowserFixtureServer, createBrowserFixtureServer } from "../test/browser-fixture";

for (const engine of [chromium, webkit]) {
  test(`${engine.name()}: attachment popover zooms without navigation and downloads authenticated bytes`, async () => {
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
    backend.get("/api/sent-files/*", (request, reply) => {
      const url = new URL(request.url, "http://localhost");
      const authenticated = request.headers.cookie?.includes("attachment-auth=test") ?? false;
      requests.push({ search: url.search, authenticated });
      if (!authenticated) return reply.code(401).send();
      if (url.searchParams.has("download"))
        reply.header("content-disposition", "attachment; filename=Cabin.jpg");
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
    const browser = (await engine.launch({ headless: true })) as unknown as Browser;
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
      expect(
        await dialog.locator("img").evaluate((image) => getComputedStyle(image).transform),
      ).toBe("matrix(1.5, 0, 0, 1.5, -40, 0)");
      await dialog.getByRole("button", { name: "Reset zoom" }).click();

      // Two captured touch pointers pinch around their midpoint; one remaining finger pans.
      // WebKit's runner has no multi-touch injection API: dispatch the same pointer sequence there.
      const surface = dialog.locator(".image-viewer");
      if (engine.name() === "chromium") {
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
      } else
        await surface.evaluate((element) => {
          element.setPointerCapture = () => {};
          const send = (type: string, id: number, x: number, y: number) =>
            element.dispatchEvent(
              new PointerEvent(type, {
                bubbles: true,
                pointerId: id,
                pointerType: "touch",
                button: 0,
                clientX: x,
                clientY: y,
              }),
            );
          send("pointerdown", 1, 150, 300);
          send("pointerdown", 2, 250, 300);
          send("pointermove", 1, 100, 300);
          send("pointermove", 2, 300, 300);
          send("pointerup", 2, 300, 300);
          send("pointermove", 1, 120, 330);
          send("pointercancel", 1, 120, 330);
        });
      expect(
        await dialog.locator("img").evaluate((image) => getComputedStyle(image).transform),
      ).toMatch(/^matrix\(2, 0, 0, 2,/);
      expect(await surface.evaluate((element) => getComputedStyle(element).touchAction)).toBe(
        "none",
      );
      await dialog.getByRole("button", { name: "Close image" }).click();
      await expect.poll(() => dialog.isVisible()).toBe(false);
      expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(true);
      await trigger.click();
      await expect.poll(() => dialog.isVisible()).toBe(true);
      expect(
        await dialog.locator("img").evaluate((image) => getComputedStyle(image).transform),
      ).toBe("matrix(1, 0, 0, 1, 0, 0)");
      await page.keyboard.press("Escape");
      await expect.poll(() => dialog.isVisible()).toBe(false);

      const downloadPromise = page.waitForEvent("download");
      await page.getByRole("link", { name: "Download", exact: true }).click();
      const download = await downloadPromise;
      expect(download.url()).toMatch(/^blob:/);
      expect(download.suggestedFilename()).toBe("Cabin.jpg");
      expect(await fs.readFile((await download.path())!)).toEqual(original);
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
}
