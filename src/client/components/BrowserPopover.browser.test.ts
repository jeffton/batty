// @vitest-environment node
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import net from "node:net";
import { once } from "node:events";
import fastify from "fastify";
import { BrowserService } from "@/server/browser-service";
import { registerCloudBrowserRoutes } from "@/server/routes/cloud-browser";
import vue from "@vitejs/plugin-vue";
import { chromium, type Browser } from "patchright";
import sharp from "sharp";
import type { ViteDevServer } from "vite";
import { closeBrowserFixtureServer, createBrowserFixtureServer } from "../test/browser-fixture";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

let server: ViteDevServer;
let browser: Browser;
let url: string;
let jpeg: string;
let root: string;
let service: BrowserService;
const backend = fastify();
let closeStreams: () => Promise<void>;
let backendUrl: string;
let attachedBrowserId = "";
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-cloud-popover-"));
  service = new BrowserService(undefined, 4, root);
  backend.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/api/") && !request.headers.cookie?.includes("cloud-auth=test"))
      return reply.code(401).send({ error: "Authentication required" });
  });
  backend.get("/target", (_request, reply) =>
    reply.type("text/html").send(`<!doctype html>
    <html><head><title>Shared target</title></head><body style="margin:0;height:3000px">
    <button style="width:160px;height:60px" onclick="window.clicks=(window.clicks||0)+1">Tap me</button>
    <input style="display:block;width:200px;height:40px" id="typed"></body></html>`),
  );
  const reservation = net.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = (reservation.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  backendUrl = `http://127.0.0.1:${port}`;
  server = await createBrowserFixtureServer("src/client/components/BrowserPopover.fixture.html", {
    plugins: [vue()],
    resolve: { alias: { "@": path.resolve("src") } },
    server: {
      host: "127.0.0.1",
      port: 0,
      proxy: {
        "/api/cloud-browser": {
          target: backendUrl,
          rewrite: (requestPath) => requestPath.replace("/opaque/", `/${attachedBrowserId}/`),
        },
      },
    },
  });
  await server.listen();
  url = `${server.resolvedUrls!.local[0]}src/client/components/BrowserPopover.fixture.html`;
  closeStreams = registerCloudBrowserRoutes(backend, service, server.resolvedUrls!.local[0]!);
  await backend.listen({ host: "127.0.0.1", port });
  browser = await chromium.launch({ headless: true });
  jpeg = (
    await sharp({ create: { width: 1280, height: 800, channels: 3, background: "#f3c68c" } })
      .jpeg()
      .toBuffer()
  ).toString("base64");
}, 30_000);
afterAll(async () => {
  await browser?.close();
  await closeStreams?.();
  await service?.closeSession("integration");
  await service?.dispose();
  await backend.close();
  if (server) await closeBrowserFixtureServer(server);
  if (root) await fs.rm(root, { recursive: true, force: true });
});

test("mobile native attachment opens an interactive image, maps coordinates, and keeps remote size stable when view shrinks", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const commands: Record<string, unknown>[] = [];
  const state = {
    pageId: "page-1",
    revision: "painted-revision",
    url: "https://example.org",
    title: "Example",
    width: 1280,
    height: 800,
    pages: [{ id: "page-1", title: "Example", url: "https://example.org", active: true }],
  };
  try {
    await page.route("**/api/cloud-browser/opaque/**", async (route) => {
      const request = route.request();
      if (request.url().endsWith("/events")) {
        await route.fulfill({
          contentType: "text/event-stream",
          body: `event: frame\ndata: ${JSON.stringify({ image: jpeg, pageId: "page-1", revision: "painted-revision", width: 1280, height: 800 })}\n\n`,
        });
      } else {
        if (request.method() === "POST") commands.push(request.postDataJSON());
        await route.fulfill({ json: state });
      }
    });
    await page.goto(url);
    await page.getByRole("button", { name: "Open browser", exact: true }).click();
    const popover = page.locator("#site-preview--cloud");
    const image = popover.getByRole("img");
    await image.waitFor();
    await expect
      .poll(() =>
        image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0),
      )
      .toBe(true);
    expect(await popover.locator("iframe").count()).toBe(0);
    expect(await popover.getByRole("switch").count()).toBe(0);
    const bounds = (await image.boundingBox())!;
    await image.click({ position: { x: bounds.width / 4, y: bounds.height / 4 } });
    await expect.poll(() => commands.length).toBe(1);
    expect(commands[0]).toEqual({
      action: "click",
      pageId: "page-1",
      revision: "painted-revision",
      x: 320,
      y: 200,
    });
    await page.setViewportSize({ width: 390, height: 400 });
    const text = popover.getByRole("textbox", { name: "Text for focused browser field" });
    await text.fill("Hello from iPhone");
    await popover.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => commands.length).toBe(2);
    expect(commands[1]).toEqual({
      action: "text",
      text: "Hello from iPhone",
      pageId: "page-1",
      revision: "painted-revision",
    });
    expect(commands.some((command) => command.action === "viewport")).toBe(false);
    await popover.getByRole("button", { name: "Close popover" }).click();
    expect(commands.some((command) => command.action === "close-page")).toBe(false);
    await page.getByRole("button", { name: "Open site", exact: true }).click();
    const ordinary = page.locator("#site-preview--ordinary");
    expect(await ordinary.locator("iframe").count()).toBe(1);
    expect(await ordinary.getByRole("switch").count()).toBe(1);
  } finally {
    await page.close();
  }
});

test("real authenticated popover stream and touch controls change the agent's persistent page", async () => {
  await service.execute("integration", {
    action: "open",
    url: `${backendUrl}/target`,
    cloud: true,
  });
  const attachment = await service.execute("integration", { action: "attach" });
  attachedBrowserId = attachment.details.sites![0]!.browserId!;
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  await context.addCookies([
    { name: "cloud-auth", value: "test", url: server.resolvedUrls!.local[0]! },
  ]);
  const page = await context.newPage();
  try {
    await page.goto(url);
    await page.getByRole("button", { name: "Open browser", exact: true }).click();
    const popover = page.locator("#site-preview--cloud");
    const image = popover.getByRole("img");
    await expect.poll(() => image.count()).toBe(1);
    await expect
      .poll(() =>
        image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0),
      )
      .toBe(true);
    await expect
      .poll(() => popover.getByRole("button", { name: "Enter", exact: true }).isEnabled())
      .toBe(true);
    const bounds = (await image.boundingBox())!;
    const tapped = page.waitForResponse((response) => response.url().endsWith("/control"));
    await page.touchscreen.tap(
      bounds.x + (bounds.width * 40) / 390,
      bounds.y + (bounds.height * 30) / 640,
    );
    expect((await tapped).status()).toBe(200);
    await expect
      .poll(
        async () =>
          (await service.execute("integration", { action: "evaluate", script: "window.clicks" }))
            .text,
      )
      .toContain("result:\n1");
    await expect
      .poll(() => popover.getByRole("button", { name: "Enter", exact: true }).isEnabled())
      .toBe(true);
    const focused = page.waitForResponse((response) => response.url().endsWith("/control"));
    await page.touchscreen.tap(
      bounds.x + (bounds.width * 80) / 390,
      bounds.y + (bounds.height * 85) / 640,
    );
    expect((await focused).status()).toBe(200);
    await expect
      .poll(() => popover.getByRole("button", { name: "Send", exact: true }).isDisabled())
      .toBe(true);
    await popover
      .getByRole("textbox", { name: "Text for focused browser field" })
      .fill("Live shared browser æøå");
    await expect
      .poll(() => popover.getByRole("button", { name: "Send", exact: true }).isEnabled())
      .toBe(true);
    const typed = page.waitForResponse((response) => response.url().endsWith("/control"));
    await popover.getByRole("button", { name: "Send", exact: true }).click();
    expect((await typed).status()).toBe(200);
    await expect
      .poll(
        async () =>
          (
            await service.execute("integration", {
              action: "evaluate",
              script: "document.querySelector('#typed').value",
            })
          ).text,
      )
      .toContain("Live shared browser æøå");
    await popover.getByRole("button", { name: "Close popover" }).click();
    expect(await service.hasSession("integration")).toBe(true);
    expect((await service.cloudState(attachedBrowserId)).title).toBe("Shared target");
  } finally {
    await context.close();
  }
}, 30_000);
