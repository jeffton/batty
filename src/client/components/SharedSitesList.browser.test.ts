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
import { registerSiteFunction } from "@/server/site-functions";
import { closeBrowserFixtureServer, createBrowserFixtureServer } from "../test/browser-fixture";

test.each(["/", "/batty", "/nested/app"])(
  "stored site previews load image assets through a prefix-stripping proxy at %s",
  async (baseUrl) => {
    const sitesDir = await fs.mkdtemp(path.join(os.tmpdir(), "batty-site-preview-"));
    const backend = fastify();
    const site = await createSite(sitesDir, baseUrl, "Gallery");
    const prefix = baseUrl === "/" ? "" : baseUrl;
    await registerSiteFunction(sitesDir, site.descriptor.id, "echo", {
      code: "const input = await tools.input(); return { message: input.message.toUpperCase() };",
    });
    await fs.writeFile(
      path.join(site.directory, "index.html"),
      `<img src="photo.svg" alt="Fixture image"><script src="${prefix}/site-runtime.js"></script><button onclick="batty.call('echo', {message: 'blue animal'}).then(value => document.querySelector('output').textContent = value.message).catch(error => document.querySelector('output').textContent = error.message)">Generate</button><button onclick="batty.call('delay', {message: document.body.dataset.message, ms: Number(document.body.dataset.ms)}).then(value => document.querySelector('output').textContent = value)">Delayed</button><output></output>`,
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
    const fixture = "src/client/components/SharedSitesList.fixture.html";
    const server = await createBrowserFixtureServer(fixture, {
      plugins: [vue()],
      resolve: { alias: { "@": path.resolve("src") } },
      server: {
        host: "127.0.0.1",
        port: 0,
        proxy: {
          [`${prefix}/site-runtime.js`]: {
            target: backendUrl,
            rewrite: (url) => url.slice(prefix.length),
          },
          [`${prefix}/api/sites`]: {
            target: backendUrl,
            rewrite: (url) => url.slice(prefix.length),
          },
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
      await frame.getByRole("button", { name: "Generate" }).click();
      await expect
        .poll(() => frame.locator("output").textContent(), { timeout: 10000 })
        .toBe("BLUE ANIMAL");
      expect(await page.locator("iframe").getAttribute("sandbox")).not.toContain(
        "allow-same-origin",
      );
      if (baseUrl === "/") {
        await registerSiteFunction(sitesDir, site.descriptor.id, "delay", {
          code: "const input = await tools.input(); const end = Date.now() + input.ms; while(Date.now() < end) {} return input.message;",
        });
        const reload = async (marker: string) => {
          const navigation = page.waitForEvent(
            "framenavigated",
            (candidate) => candidate.parentFrame() !== null && candidate.url().includes(marker),
          );
          await page.locator("iframe").evaluate((element, value) => {
            (element as HTMLIFrameElement).src += `&${value}`;
          }, marker);
          await navigation;
          await frame.getByRole("button", { name: "Generate" }).waitFor();
        };
        const invoke = async (message: string, ms: number) => {
          await frame.locator("body").evaluate(
            (element, input) => {
              element.dataset.message = input.message;
              element.dataset.ms = String(input.ms);
            },
            { message, ms },
          );
          await frame.getByRole("button", { name: "Delayed", exact: true }).click();
        };
        // Both documents start at request id 1. A WindowProxy survives this reload.
        await reload("first-document");
        const requested = page.waitForRequest((request) =>
          request.url().endsWith("/functions/delay"),
        );
        await invoke("old-document", 400);
        await requested;
        await reload("second-document");
        await invoke("new-document", 900);
        await expect
          .poll(() => frame.locator("output").textContent(), { timeout: 5000 })
          .toBe("new-document");
      }
    } finally {
      await browser.close();
      await closeBrowserFixtureServer(server);
      await backend.close();
      await fs.rm(sitesDir, { recursive: true, force: true });
    }
  },
);
