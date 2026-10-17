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
import { chromium, type Browser, type Page } from "patchright";
import type { ViteDevServer } from "vite";
import { closeBrowserFixtureServer, createBrowserFixtureServer } from "../test/browser-fixture";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

let server: ViteDevServer;
let browser: Browser;
let url: string;
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
  backend.get("/target", (request, reply) =>
    reply.type("text/html").send(`<!doctype html>
    <html><head><meta name="viewport" content="width=device-width"><title>Shared target</title></head>
    <body data-server-mobile="${/Mobile/.test(request.headers["user-agent"] ?? "")}" style="margin:0;font:16px sans-serif;min-width:${/Mobile/.test(request.headers["user-agent"] ?? "") ? 0 : 1100}px">
      <button style="width:160px;height:50px" onclick="document.body.dataset.clicks=String(Number(document.body.dataset.clicks||0)+1)">Tap me</button>
      <form onsubmit="event.preventDefault();document.body.dataset.submitted='yes'">
        <input style="display:block;width:200px;height:40px" id="typed" value="original">
      </form>
      <div id="inner" onscroll="document.body.dataset.firstScrollAt ||= String(Date.now())" style="height:160px;width:250px;overflow:auto;overscroll-behavior:contain;background:lightblue">
        <div style="height:900px">Inner scroll</div><button id="inner-bottom">Inner bottom</button>
      </div>
      <div style="height:2400px">Long page</div>
      <button id="bottom" style="height:55px" onclick="document.body.dataset.bottomClicked='yes'">Page bottom</button>
      <a id="popup" target="_blank" href="/popup">Open popup</a>
    </body></html>`),
  );
  backend.get("/coverage", (_request, reply) =>
    reply.type("text/html").send(`<!doctype html>
    <meta name="viewport" content="width=device-width"><title>Full viewport coverage</title>
    <style>html,body{margin:0}body{height:3000px}#coverage{position:fixed;inset:0;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;pointer-events:none}#coverage div:nth-child(1){background:red}#coverage div:nth-child(2){background:lime}#coverage div:nth-child(3){background:blue}#coverage div:nth-child(4){background:yellow}#edge{position:fixed;left:80vw;top:80vh;width:15vw;height:10vh}#pane{position:fixed;left:5vw;top:35vh;width:35vw;height:20vh;overflow:auto;background:#ccc;overscroll-behavior:contain}</style>
    <div id="coverage"><div></div><div></div><div></div><div></div></div>
    <div id="pane"><div style="height:1000px">Inner scrolling</div></div>
    <button id="edge" onclick="document.body.dataset.clicks=String(Number(document.body.dataset.clicks||0)+1)">Edge click</button>`),
  );
  backend.get("/popup", (_request, reply) =>
    reply.type("text/html").send("<title>Popup target</title><p>Popup</p>"),
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
          ws: true,
          rewrite: (requestPath) => requestPath.replace("/opaque/", `/${attachedBrowserId}/`),
        },
      },
    },
  });
  await server.listen();
  url = `${server.resolvedUrls!.local[0]}src/client/components/BrowserPopover.fixture.html`;
  closeStreams = await registerCloudBrowserRoutes(backend, service, server.resolvedUrls!.local[0]!);
  await backend.listen({ host: "127.0.0.1", port });
  browser = await chromium.launch({ headless: true });
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

async function inspect(script: string) {
  // Read the same live page without an agent action invalidating its revision.
  return (await service.cloudTarget(attachedBrowserId)).page.evaluate(
    // eslint-disable-next-line no-eval -- Read-only assertions inspect the page's main world.
    (source) => globalThis.eval(source),
    script,
  );
}
async function tapRemote(page: Page, x: number, y: number) {
  const image = page.locator(".cloud-browser__image");
  const state = await service.cloudState(attachedBrowserId);
  await expect.poll(() => image.getAttribute("data-revision")).toBe(state.revision);
  const bounds = (await image.boundingBox())!;
  const done = page.waitForResponse(
    (r) => r.url().endsWith("/control") && r.request().postDataJSON().action === "click",
  );
  await page.touchscreen.tap(
    bounds.x + (x * bounds.width) / state.width,
    bounds.y + (y * bounds.height) / state.height,
  );
  const response = await done;
  expect(response.status()).toBe(200);
}
async function swipe(page: Page, x: number, y: number, distance: number) {
  const image = page.locator(".cloud-browser__image");
  const state = await service.cloudState(attachedBrowserId);
  await expect.poll(() => image.getAttribute("data-revision")).toBe(state.revision);
  const bounds = (await image.boundingBox())!;
  const px = bounds.x + (x * bounds.width) / state.width;
  const py = bounds.y + (y * bounds.height) / state.height;
  const touch = await page.context().newCDPSession(page);
  try {
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: px, y: py }],
    });
    for (let step = 1; step <= 5; step++) {
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: px, y: py - (distance * step) / 5 }],
      });
      await new Promise((resolve) => setTimeout(resolve, 35));
    }
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await touch.detach();
  }
}

test("mobile live session fits its viewport, edits contextually, scrolls nested content and reaches/clicks the page bottom", async () => {
  await service.execute("integration", {
    action: "open",
    url: `${backendUrl}/target`,
    cloud: true,
  });
  attachedBrowserId = (await service.execute("integration", { action: "attach" })).details
    .sites![0]!.browserId!;
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
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
        image.evaluate((e: HTMLCanvasElement) => e.dataset.frame !== undefined && e.width > 0),
      )
      .toBe(true);
    const remote = await service.cloudState(attachedBrowserId);
    expect(remote.mobile).toBe(true);
    expect(remote.deviceScaleFactor).toBe(3);
    expect(await image.evaluate((e: HTMLCanvasElement) => [e.width, e.height])).toEqual([
      remote.width * 3,
      remote.height * 3,
    ]);
    expect(await inspect("document.body.dataset.serverMobile")).toBe("true");
    expect(
      await inspect(
        "[innerWidth,screen.width,navigator.maxTouchPoints,matchMedia('(pointer:coarse)').matches,navigator.userAgentData.mobile]",
      ),
    ).toEqual([remote.width, remote.width, 1, true, true]);
    const bounds = (await image.boundingBox())!;
    expect(Math.abs(remote.width - bounds.width)).toBeLessThan(2);
    expect(Math.abs(remote.height - bounds.height)).toBeLessThan(2);
    const addressInput = popover.getByRole("textbox", { name: "Browser address" });
    await addressInput.tap();
    expect(
      await addressInput.evaluate((e: HTMLInputElement) => [
        e.selectionStart,
        e.selectionEnd,
        e.value.length,
      ]),
    ).toEqual([
      0,
      (await addressInput.inputValue()).length,
      (await addressInput.inputValue()).length,
    ]);
    const inputHeight = (await addressInput.boundingBox())!.height;
    expect((await popover.getByRole("button", { name: "Go back" }).boundingBox())!.height).toBe(
      inputHeight,
    );
    expect((await popover.getByRole("button", { name: "Reload page" }).boundingBox())!.height).toBe(
      inputHeight,
    );
    await addressInput.blur();
    expect(await popover.getByRole("textbox", { name: "Focused browser field" }).count()).toBe(0);
    await tapRemote(page, 40, 25);
    await expect.poll(() => inspect("document.body.dataset.clicks")).toBe("1");
    await tapRemote(page, 80, 75);
    const input = popover.getByRole("textbox", { name: "Focused browser field" });
    await input.waitFor();
    await input.tap();
    await input.fill("Live shared browser æøå");
    await expect
      .poll(() => inspect("document.querySelector('#typed').value"))
      .toBe("Live shared browser æøå");
    await input.fill("");
    await expect.poll(() => inspect("document.querySelector('#typed').value")).toBe("");
    await input.fill("edited");
    await input.press("Enter");
    await expect.poll(() => inspect("document.body.dataset.submitted")).toBe("yes");
    await page.setViewportSize({ width: 390, height: 430 });
    await expect
      .poll(async () => (await input.boundingBox())!.y + (await input.boundingBox())!.height)
      .toBeLessThan(430);
    expect((await service.cloudState(attachedBrowserId)).height).toBe(remote.height);
    await popover.getByRole("button", { name: "Done", exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(async () => (await image.boundingBox())!.height).toBe(remote.height);
    await image.evaluate((element) => {
      element.addEventListener(
        "pointermove",
        () => {
          element.setAttribute("data-scroll-start", String(Date.now()));
        },
        { once: true },
      );
    });
    // Rotation fits both dimensions without changing the page/login or reloading the form.
    const beforeRotation = (await service.cloudState(attachedBrowserId)).pageId;
    await page.setViewportSize({ width: 844, height: 390 });
    await expect
      .poll(async () => (await service.cloudState(attachedBrowserId)).width)
      .toBeGreaterThan(750);
    expect((await service.cloudState(attachedBrowserId)).pageId).toBe(beforeRotation);
    expect(await inspect("document.querySelector('#typed').value")).toBe("edited");
    expect(await inspect("screen.orientation.type")).toBe("landscape-primary");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(async () => (await service.cloudState(attachedBrowserId)).width)
      .toBe(remote.width);
    // Remote inner container, not the local popover, owns this scroll gesture.
    await swipe(page, 100, 220, 130);
    await expect
      .poll(() => inspect("document.querySelector('#inner').scrollTop"))
      .toBeGreaterThan(80);
    expect(await inspect("window.scrollY")).toBe(0);
    console.log(
      "Touch move to remote scroll (local fixture, ms):",
      Number(await inspect("document.body.dataset.firstScrollAt")) -
        Number(await image.getAttribute("data-scroll-start")),
    );

    // Wheel is routed too, and remains anchored to the nested container.
    await image.hover({ position: { x: 100, y: 190 } });
    // Chromium's injected device-pixel wheel is normalized by viewer DPR before DOM delivery.
    await page.mouse.wheel(0, 1200 * 3);
    await expect
      .poll(() => inspect("document.querySelector('#inner').scrollTop"))
      .toBeGreaterThan(700);
    // Scroll the outer page from outside the inner container.
    for (let i = 0; i < 7; i++) await swipe(page, 300, 650, 420);
    await expect
      .poll(() =>
        inspect("window.scrollY + innerHeight >= document.documentElement.scrollHeight - 2"),
      )
      .toBe(true);
    const bottom = (await inspect(
      "JSON.stringify(document.querySelector('#bottom').getBoundingClientRect().toJSON())",
    )) as string;
    const rect = JSON.parse(bottom);
    await tapRemote(page, rect.x + 30, rect.y + 20);
    await expect.poll(() => inspect("document.body.dataset.bottomClicked")).toBe("yes");
    expect(await popover.evaluate((e) => e.scrollHeight - e.clientHeight)).toBe(0);
    await page.screenshot({ path: "/tmp/batty-cloud-browser-mobile-bottom.png" });
    // A target=_blank page becomes the one visible page; Back returns to its opener.
    const popupRect = JSON.parse(
      (await inspect(
        "JSON.stringify(document.querySelector('#popup').getBoundingClientRect().toJSON())",
      )) as string,
    );
    await tapRemote(page, popupRect.x + 10, popupRect.y + 5);
    await expect
      .poll(async () => (await service.cloudState(attachedBrowserId)).title)
      .toBe("Popup target");
    await expect
      .poll(async () => (await service.cloudState(attachedBrowserId)).width)
      .toBe(remote.width);
    const popup = (await service.cloudTarget(attachedBrowserId)).page;
    await popup.evaluate(() => history.pushState({}, "", "#section"));
    await popover.getByRole("button", { name: "Go back" }).click();
    await expect
      .poll(async () => (await service.cloudState(attachedBrowserId)).url)
      .toBe(`${backendUrl}/popup`);
    expect(popup.isClosed()).toBe(false);
    await popover.getByRole("button", { name: "Go back" }).click();
    await expect
      .poll(async () => (await service.cloudState(attachedBrowserId)).title)
      .toBe("Shared target");
    await page.screenshot({ path: "/tmp/batty-cloud-browser-mobile.png" });
    await popover.getByRole("button", { name: "Close popover" }).click();
    expect(await service.hasSession("integration")).toBe(true);
  } finally {
    await context.close();
  }
}, 60_000);

test("desktop/mobile switching keeps login, CSS screen matches the viewer, and network loss reconnects without a new browser", async () => {
  await service.execute("integration", {
    action: "open",
    url: `${backendUrl}/target`,
    cloud: true,
  });
  const original = await service.cloudTarget(attachedBrowserId);
  await original.page.evaluate(() => {
    document.cookie = "login=retained;path=/";
    localStorage.setItem("login", "retained");
  });
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
  });
  for (const context of [desktop, mobile])
    await context.addCookies([
      { name: "cloud-auth", value: "test", url: server.resolvedUrls!.local[0]! },
    ]);
  try {
    const desktopPage = await desktop.newPage();
    await desktopPage.goto(url);
    await desktopPage.getByRole("button", { name: "Open browser", exact: true }).click();
    await expect.poll(async () => (await service.cloudState(attachedBrowserId)).mobile).toBe(false);
    await expect.poll(() => inspect("document.body.dataset.serverMobile")).toBe("false");
    const desktopState = await service.cloudState(attachedBrowserId);
    expect(
      await inspect(
        "[innerWidth,screen.width,navigator.maxTouchPoints,navigator.userAgentData.mobile]",
      ),
    ).toEqual([desktopState.width, desktopState.width, 0, false]);
    await desktopPage.getByRole("button", { name: "Close popover" }).click();
    const page = await mobile.newPage();
    await page.goto(url);
    await page.getByRole("button", { name: "Open browser", exact: true }).click();
    await expect.poll(async () => (await service.cloudState(attachedBrowserId)).mobile).toBe(true);
    await expect.poll(() => inspect("document.body.dataset.serverMobile")).toBe("true");
    expect((await service.cloudTarget(attachedBrowserId)).page).toBe(original.page);
    expect(
      await inspect(
        "document.cookie.includes('login=retained') && localStorage.getItem('login')==='retained'",
      ),
    ).toBe(true);
    const popover = page.locator("#site-preview--cloud");
    const image = popover.getByRole("img");
    await expect
      .poll(() =>
        image.evaluate((e: HTMLCanvasElement) => e.dataset.frame !== undefined && e.width > 0),
      )
      .toBe(true);
    expect(await inspect("document.documentElement.scrollWidth === innerWidth")).toBe(true);
    await mobile.setOffline(true);
    await expect
      .poll(() => popover.getByRole("status").textContent(), { timeout: 5000 })
      .toBe("Reconnecting…");
    await mobile.setOffline(false);
    await expect.poll(() => popover.getByRole("status").count(), { timeout: 10000 }).toBe(0);
    expect((await service.cloudTarget(attachedBrowserId)).page).toBe(original.page);
    await tapRemote(page, 40, 25);
    await expect.poll(() => inspect("document.body.dataset.clicks")).toBe("1");
    await page.screenshot({ path: "/tmp/batty-cloud-mobile-metrics.png" });
    await popover.getByRole("button", { name: "Close popover" }).click();
  } finally {
    await desktop.close();
    await mobile.close();
  }
}, 60_000);

test("DPR3 binary frames fill the actual popover, retain edge input alignment and rotate without padded quadrants", async () => {
  await service.execute("integration", {
    action: "open",
    url: `${backendUrl}/coverage`,
    cloud: true,
  });
  attachedBrowserId = (await service.execute("integration", { action: "attach" })).details
    .sites![0]!.browserId!;
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  await context.addCookies([
    { name: "cloud-auth", value: "test", url: server.resolvedUrls!.local[0]! },
  ]);
  const page = await context.newPage();
  try {
    await page.goto(url);
    await page.getByRole("button", { name: "Open browser", exact: true }).click();
    const canvas = page.locator(".cloud-browser__image");
    const colors = () =>
      canvas.evaluate((element: HTMLCanvasElement) => {
        const context = element.getContext("2d")!;
        return [
          [0.1, 0.1],
          [0.9, 0.1],
          [0.1, 0.95],
          [0.9, 0.95],
        ].map(([x, y]) =>
          [
            ...context.getImageData(
              Math.floor(element.width * x!),
              Math.floor(element.height * y!),
              1,
              1,
            ).data,
          ]
            .slice(0, 3)
            .map((value) => value > 230),
        );
      });
    const expected = [
      [true, false, false],
      [false, true, false],
      [false, false, true],
      [true, true, false],
    ];
    await expect.poll(() => canvas.getAttribute("data-frame")).not.toBeNull();
    const original = await service.cloudTarget(attachedBrowserId);
    await expect.poll(() => canvas.getAttribute("data-revision")).toBe(original.state.revision);
    await page.screenshot({ path: "/tmp/cloud-coverage-portrait.png" });
    // A large bitmap is insufficient: all four viewport corners must contain the page.
    await expect.poll(colors).toEqual(expected);
    expect(
      await canvas.evaluate((element: HTMLCanvasElement) => [element.width, element.height]),
    ).toEqual([original.state.width * 3, original.state.height * 3]);
    await tapRemote(page, original.state.width * 0.875, original.state.height * 0.85);
    await expect.poll(() => inspect("document.body.dataset.clicks")).toBe("1");
    await swipe(page, original.state.width * 0.2, original.state.height * 0.45, 80);
    await expect
      .poll(() => inspect("document.querySelector('#pane').scrollTop"))
      .toBeGreaterThan(60);
    expect(await inspect("scrollY")).toBe(0);
    await expect.poll(colors).toEqual(expected);
    await swipe(page, original.state.width * 0.7, original.state.height * 0.65, 120);
    await expect.poll(() => inspect("scrollY")).toBeGreaterThan(90);
    await expect.poll(colors).toEqual(expected);
    await service.execute("integration", { action: "click", selector: "#edge" });
    await expect.poll(() => inspect("document.body.dataset.clicks")).toBe("2");
    await page.setViewportSize({ width: 844, height: 390 });
    await expect
      .poll(async () => (await service.cloudState(attachedBrowserId)).width)
      .toBeGreaterThan(750);
    const rotated = await service.cloudState(attachedBrowserId);
    await expect.poll(() => canvas.getAttribute("data-revision")).toBe(rotated.revision);
    await expect.poll(colors).toEqual(expected);
    await tapRemote(page, rotated.width * 0.875, rotated.height * 0.85);
    await expect.poll(() => inspect("document.body.dataset.clicks")).toBe("3");
    expect((await service.cloudTarget(attachedBrowserId)).page).toBe(original.page);
    expect(await inspect("[innerWidth,innerHeight,devicePixelRatio]")).toEqual([
      rotated.width,
      rotated.height,
      3,
    ]);
    await page.screenshot({ path: "/tmp/cloud-coverage-landscape.png" });
    await page.getByRole("button", { name: "Close popover" }).click();
  } finally {
    await context.close();
  }
}, 60_000);
