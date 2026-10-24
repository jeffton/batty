// @vitest-environment node
import fs from "node:fs/promises";
import path from "node:path";
import fastify from "fastify";
import vue from "@vitejs/plugin-vue";
import { chromium } from "patchright";
import sharp from "sharp";
import { expect, test } from "vite-plus/test";
import { closeBrowserFixtureServer, createBrowserFixtureServer } from "../test/browser-fixture";

test("attachment clicks open the original inline and download the authenticated original bytes", async () => {
  const original = await sharp({
    create: { width: 32, height: 24, channels: 3, background: "#008080" },
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
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addCookies([{ name: "attachment-auth", value: "test", url: origin }]);
  const page = await context.newPage();
  try {
    await page.goto(
      origin +
        "src/client/components/AttachedFilesList.fixture.html?original=" +
        encodeURIComponent(route),
    );
    await page.locator("img").evaluate((image: HTMLImageElement) => image.decode());
    const popupPromise = page.waitForEvent("popup");
    await page.getByRole("link", { name: "Open original: Cabin.jpg" }).click();
    const popup = await popupPromise;
    await popup.waitForLoadState();
    expect(new URL(popup.url()).search).toBe("");
    expect(
      await popup.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth),
    ).toBe(32);
    await popup.close();

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download", exact: true }).click();
    const download = await downloadPromise;
    expect(download.url()).toBe(new URL(route + "?download=1", origin).href);
    expect(download.suggestedFilename()).toBe("Cabin.jpg");
    expect(await fs.readFile((await download.path())!)).toEqual(original);
    expect(requests.map((request) => request.search)).toEqual(["?preview=1", "", "?download=1"]);
    expect(requests.every((request) => request.authenticated)).toBe(true);

    // Active image formats must remain download-only on the authenticated app origin.
    await page.goto(
      origin +
        "src/client/components/AttachedFilesList.fixture.html?mime=image%2Fsvg%2Bxml&original=" +
        encodeURIComponent(route),
    );
    const svgDownloadPromise = page.waitForEvent("download");
    await page.getByRole("link", { name: "Open original: Cabin.jpg" }).click();
    const svgDownload = await svgDownloadPromise;
    expect(svgDownload.url()).toBe(new URL(route + "?download=1", origin).href);
    expect(await fs.readFile((await svgDownload.path())!)).toEqual(original);
  } finally {
    await browser.close();
    await closeBrowserFixtureServer(server);
    await backend.close();
  }
}, 30_000);
