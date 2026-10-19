// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fastify from "fastify";
import vue from "@vitejs/plugin-vue";
import { chromium } from "patchright";
import { expect, test } from "vite-plus/test";
import type { AppConfig } from "@/server/config";
import { createSite } from "@/server/sites";
import { registerSiteRoutes } from "@/server/routes/sites";
import { closeBrowserFixtureServer, createBrowserFixtureServer } from "../test/browser-fixture";

test.each(["/", "/batty", "/nested/app"])(
  "stored site previews load image assets through a prefix-stripping proxy at %s",
  async (baseUrl) => {
    const sitesDir = await fs.mkdtemp(path.join(os.tmpdir(), "batty-site-preview-"));
    const backend = fastify();
    const site = await createSite(sitesDir, baseUrl, "Gallery");
    await fs.writeFile(
      path.join(site.directory, "index.html"),
      '<img src="photo.svg" alt="Fixture image">',
    );
    await fs.writeFile(
      path.join(site.directory, "photo.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="red"/></svg>',
    );
    backend.decorateRequest("auth", false);
    backend.addHook("onRequest", async (request) => {
      request.auth = request.headers.cookie?.includes("fixture-auth=yes") ?? false;
    });
    registerSiteRoutes({
      app: backend,
      config: { sitesDir, baseUrl } as AppConfig,
      routePath: (route) => route,
    });
    const backendUrl = await backend.listen({ host: "127.0.0.1", port: 0 });
    const prefix = baseUrl === "/" ? "" : baseUrl;
    const fixture = "src/client/components/SharedSitesList.fixture.html";
    const server = await createBrowserFixtureServer(fixture, {
      plugins: [vue()],
      resolve: { alias: { "@": path.resolve("src") } },
      server: {
        host: "127.0.0.1",
        port: 0,
        proxy: {
          [`${prefix}/sites`]: { target: backendUrl, rewrite: (url) => url.slice(prefix.length) },
          [`${prefix}/site-preview`]: {
            target: backendUrl,
            rewrite: (url) => url.slice(prefix.length),
          },
        },
      },
    });
    const browser = await chromium.launch({ headless: true });
    try {
      await server.listen();
      const origin = server.resolvedUrls!.local[0]!;
      const context = await browser.newContext();
      await context.addCookies([{ name: "fixture-auth", value: "yes", url: origin }]);
      const page = await context.newPage();
      await page.goto(
        `${origin}${fixture}?${new URLSearchParams({ base: baseUrl, id: site.descriptor.id })}`,
      );
      await page.getByRole("button", { name: "Open site", exact: true }).click();
      const frame = page.frameLocator("iframe");
      await expect
        .poll(() =>
          frame
            .getByAltText("Fixture image")
            .evaluate((image) => (image as HTMLImageElement).naturalWidth),
        )
        .toBe(20);
      const frameUrl = page
        .frames()
        .find((frame) => frame.parentFrame() !== null)!
        .url();
      expect(new URL(frameUrl).pathname).toBe(site.browserUrl);
      const imageUrl = await frame.getByAltText("Fixture image").getAttribute("src");
      expect(new URL(imageUrl!, frameUrl).pathname).toBe(`${site.browserUrl}photo.svg`);
    } finally {
      await browser.close();
      await closeBrowserFixtureServer(server);
      await backend.close();
      await fs.rm(sitesDir, { recursive: true, force: true });
    }
  },
);
