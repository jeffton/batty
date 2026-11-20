import { fixtureOperation, setFixtureRpcHandler } from "../test/socket-fixture";
import { createOwnerRpcHandler, type OwnerRpcServices } from "@/server/owner-rpc";
import type { Runtime } from "@/server/runtime";
// @vitest-environment node
import path from "node:path";
import fs from "node:fs/promises";
import { removeTestBrowserRoot } from "@/server/test-browser-cleanup";
import os from "node:os";
import net from "node:net";
import { once } from "node:events";
import fastify from "fastify";
import { BrowserService, workspaceBrowserKey } from "@/server/browser-service";
import { registerCloudBrowserLauncher } from "@/server/cloud-browser-launcher";
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
// Control flows use DPR1; the dedicated DPR3 test covers high-density capture
// and input alignment without re-encoding every gesture at nine times the pixels.
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-cloud-popover-"));
  service = new BrowserService(undefined, 4, root);
  await fs.mkdir(path.join(root, "workspaces", "integration"), { recursive: true });
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
  backend.get<{ Params: { color: string } }>("/color/:color", (request, reply) =>
    reply.type("text/html").send(`<!doctype html><title>${request.params.color}</title>
      <style>html,body{margin:0;height:100%;background:${request.params.color}}</style>`),
  );
  backend.get("/coverage", (_request, reply) =>
    reply.type("text/html").send(`<!doctype html>
    <meta name="viewport" content="width=device-width"><title>Full viewport coverage</title>
    <style>html,body{margin:0}body{height:3000px}#coverage{position:fixed;inset:0;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;pointer-events:none}#coverage div:nth-child(1){background:red}#coverage div:nth-child(2){background:lime}#coverage div:nth-child(3){background:blue}#coverage div:nth-child(4){background:yellow}#edge{position:fixed;left:80vw;top:80vh;width:15vw;height:10vh}#pane{position:fixed;left:5vw;top:35vh;width:35vw;height:20vh;overflow:auto;background:#ccc;overscroll-behavior:contain}</style>
    <div id="coverage"><div></div><div></div><div></div><div></div></div>
    <div id="pane"><div style="height:1000px">Inner scrolling</div></div>
    <button id="edge" onclick="document.body.dataset.clicks=String(Number(document.body.dataset.clicks||0)+1)">Edge click</button>`),
  );
  backend.get("/touch", (_request, reply) =>
    reply.type("text/html").send(`<!doctype html>
    <meta name="viewport" content="width=device-width"><style>body{margin:0;height:6000px}#pane{position:absolute;top:100px;left:20px;width:300px;height:450px;overflow:auto;overscroll-behavior:contain}#pane div{height:5000px;background:linear-gradient(red,blue)}#drag{position:fixed;top:100px;right:0;width:50px;height:450px;touch-action:none;background:green}</style>
    <button style="height:60px;width:120px" onclick="document.body.dataset.clicks=String(Number(document.body.dataset.clicks||0)+1)">Tap</button>
    <div id="pane"><div>Nested</div></div><div id="drag" onpointermove="this.dataset.moves=String(Number(this.dataset.moves||0)+1)"></div>
    <script>document.addEventListener('touchstart',()=>document.body.dataset.starts=String(Number(document.body.dataset.starts||0)+1),{passive:true});document.addEventListener('touchend',()=>{document.body.dataset.releaseInner=String(document.querySelector('#pane').scrollTop);document.body.dataset.releaseOuter=String(scrollY)},{passive:true});document.addEventListener('touchcancel',()=>document.body.dataset.cancels=String(Number(document.body.dataset.cancels||0)+1),{passive:true});</script>`),
  );
  backend.get("/login", (_request, reply) =>
    reply
      .type("text/html")
      .send(
        `<!doctype html><meta name="viewport" content="width=device-width"><form onsubmit="event.preventDefault();document.body.dataset.submitted='yes'"><label>Username<input autocomplete="username" name="username"></label><label>Password<input name="password" type="password" autocomplete="current-password"></label><button>Sign in</button></form>`,
      ),
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
    define: { __BATTY_BUILD_ID__: JSON.stringify("dev") },
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
  const nativeHandler = createOwnerRpcHandler(
    {
      config: { battyDir: root, workspacesRoots: [path.join(root, "workspaces")] },
      tools: { browserService: service, mcp: {} },
    } as unknown as Runtime,
    { browserAvailable: true } as OwnerRpcServices,
  );
  setFixtureRpcHandler(server, (operation, input, context) => {
    // The fixture uses the same opaque attachment alias as the video proxy.
    const payload = input as { browserId?: string };
    return nativeHandler(
      operation,
      payload.browserId === "opaque" ? { ...payload, browserId: attachedBrowserId } : input,
      context,
    );
  });
  await server.listen();
  url = `${server.resolvedUrls!.local[0]}src/client/components/BrowserPopover.fixture.html`;
  closeStreams = await registerCloudBrowserRoutes(backend, service, server.resolvedUrls!.local[0]!);
  registerCloudBrowserLauncher(backend, service, server.resolvedUrls!.local[0]!, true, async () => [
    "integration",
  ]);
  await backend.listen({ host: "127.0.0.1", port });
  browser = await chromium.launch({ headless: true });
}, 30_000);
afterAll(async () => {
  await browser?.close();
  await closeStreams?.();
  await service?.closeSession("integration");
  await service?.closeSession(workspaceBrowserKey("integration"));
  await service?.dispose();
  await backend.close();
  if (server) await closeBrowserFixtureServer(server);
  if (root) await removeTestBrowserRoot(root);
});

test.each([390, 1100])(
  "native pixels, address and selected tab stay aligned at %ipx",
  async (width) => {
    const owner = "native-alignment";
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      deviceScaleFactor: 1,
    });
    try {
      await service.execute(owner, { action: "open", url: `${backendUrl}/color/red`, cloud: true });
      attachedBrowserId = (await service.execute(owner, { action: "attach" })).details.sites![0]!
        .browserId!;
      await context.addCookies([
        { name: "cloud-auth", value: "test", url: server.resolvedUrls!.local[0]! },
      ]);
      const page = await context.newPage();
      await page.goto(url);
      await page.getByRole("button", { name: "Open browser", exact: true }).click();
      const canvas = page.locator("canvas");
      const aligned = async (color: "red" | "blue") => {
        await expect
          .poll(
            async () =>
              (await canvas.getAttribute("data-revision")) ===
              (await service.cloudState(attachedBrowserId)).revision,
            // A new native capture must be encoded, streamed and decoded after
            // tab changes; allow that pipeline to converge under suite load.
            { timeout: 10_000 },
          )
          .toBe(true);
        const state = await service.cloudState(attachedBrowserId);
        expect(await canvas.isVisible()).toBe(true);
        expect(await page.getByRole("textbox", { name: "Browser address" }).inputValue()).toBe(
          state.url,
        );
        await expect
          .poll(() =>
            canvas.evaluate((element: HTMLCanvasElement) => {
              const pixel = element
                .getContext("2d")!
                .getImageData(element.width / 2, element.height / 2, 1, 1).data;
              return pixel[0]! > 240 && pixel[2]! < 15
                ? "red"
                : pixel[2]! > 240 && pixel[0]! < 15
                  ? "blue"
                  : "other";
            }),
          )
          .toBe(color);
        await page.getByRole("button", { name: "Choose tab", exact: true }).click();
        expect(
          await page.locator('.cloud-browser-tabs__select[aria-current="page"]').textContent(),
        ).toContain(color);
        await page.getByRole("button", { name: "Choose tab", exact: true }).click();
      };
      await aligned("red");
      const viewer = await service.cloudTarget(attachedBrowserId);
      const opened = await service.execute(
        owner,
        { action: "open", url: `${backendUrl}/color/blue`, newPage: true },
        undefined,
        "worker",
      );
      await aligned("red");
      const worker = viewer.page
        .context()
        .pages()
        .find((candidate) => candidate.url().endsWith("/color/blue"))!;
      const beforePopup = await service.cloudState(attachedBrowserId);
      const popupEvent = viewer.page.context().waitForEvent("page");
      await worker.evaluate(() => {
        setTimeout(() => window.open("/color/blue"), 50);
      });
      const popup = await popupEvent;
      await popup.waitForLoadState("domcontentloaded");
      await expect
        .poll(async () => (await service.cloudState(attachedBrowserId)).revision)
        .not.toBe(beforePopup.revision);
      await aligned("red");
      await page.getByRole("button", { name: "Choose tab", exact: true }).click();
      await page.locator(".cloud-browser-tabs__select").filter({ hasText: "blue" }).first().click();
      await expect
        .poll(async () => (await service.cloudState(attachedBrowserId)).pageId)
        .toBe(opened.details.pageId);
      await aligned("blue");
    } finally {
      await context.close();
      await service.closeSession(owner);
    }
  },
);

test("autofill detects login steps without submitting or exposing values to controls", async () => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
  });
  try {
    await service.execute("integration", {
      action: "open",
      url: `${backendUrl}/login`,
      cloud: true,
    });
    attachedBrowserId = (await service.execute("integration", { action: "attach" })).details
      .sites![0]!.browserId!;
    await context.addCookies([
      { name: "cloud-auth", value: "test", url: server.resolvedUrls!.local[0]! },
    ]);
    const page = await context.newPage();
    const controls: string[] = [];
    let rejectCorrection = true;
    await fixtureOperation(
      server,
      page,
      "browser.credentials.fill",
      async (input, _context, next) => {
        if (rejectCorrection && input.credentials.password === "test-corrected-password") {
          rejectCorrection = false;
          throw new Error("test-only transport failure");
        }
        return next();
      },
    );
    let releasePrepare!: () => void;
    const heldPrepare = new Promise<void>((resolve) => {
      releasePrepare = resolve;
    });
    await fixtureOperation(
      server,
      page,
      "browser.credentials.prepare",
      async (_input, _context, next) => {
        await heldPrepare;
        return next();
      },
    );
    await fixtureOperation(server, page, "browser.control", async (input, _context, next) => {
      expect(input.browserId).toBe("opaque");
      controls.push(JSON.stringify(input.control));
      return next();
    });
    await page.goto(url);
    await page.getByRole("button", { name: "Open browser", exact: true }).click();
    expect(await page.getByRole("button", { name: "Fill saved login", exact: true }).count()).toBe(
      0,
    );
    await expect
      .poll(
        () =>
          page
            .locator(".cloud-browser__image")
            .evaluate(
              (canvas: HTMLCanvasElement) => canvas.width > 0 && canvas.dataset.frame !== undefined,
            ),
        { timeout: 10000 },
      )
      .toBe(true);
    await expect.poll(() => page.getByRole("status").count()).toBe(0);
    const panel = page.getByRole("form", { name: `Remote login at ${new URL(backendUrl).origin}` });
    const username = panel.getByRole("textbox", { name: "Username or email" });
    const password = panel.getByLabel("Password", { exact: true });
    const address = page.getByRole("textbox", { name: "Browser address" });
    const remote = (await service.cloudTarget(attachedBrowserId)).page;
    expect(await address.inputValue()).toBe(new URL(backendUrl).origin);
    await expectCompactAddressRow(page);
    await address.focus();
    expect(await address.inputValue()).toBe(`${backendUrl}/login`);
    await address.blur();
    expect(await address.inputValue()).toBe(new URL(backendUrl).origin);
    expect(await panel.textContent()).not.toContain(new URL(backendUrl).origin);
    expect(await panel.getByRole("button").count()).toBe(0);
    const userBounds = (await username.boundingBox())!;
    const passBounds = (await password.boundingBox())!;
    expect(userBounds.width).toBe(passBounds.width);
    expect(userBounds.height).toBe(passBounds.height);
    expect(userBounds.x).toBe(passBounds.x);
    expect(userBounds.x + userBounds.width).toBeLessThanOrEqual(390);
    await username.pressSequentially("test-local-user");
    await username.press("Tab");
    expect(await password.evaluate((el) => el === document.activeElement)).toBe(true);
    // Simulate a password manager updating both DOM inputs without input events.
    await panel.evaluate((form) => {
      form.querySelector<HTMLInputElement>('[name="username"]')!.value = "test-manager-user";
      form.querySelector<HTMLInputElement>('[name="password"]')!.value = "test-local-password";
    });
    await page.getByRole("status", { name: "Filling remote login" }).waitFor();
    const signIn = (await remote.getByRole("button", { name: "Sign in" }).boundingBox())!;
    const state = await service.cloudState(attachedBrowserId);
    const canvas = (await page.locator(".cloud-browser__image").boundingBox())!;
    const x = signIn.x + signIn.width / 2;
    const y = signIn.y + signIn.height / 2;
    await page.mouse.click(
      canvas.x + (x * canvas.width) / state.width,
      canvas.y + (y * canvas.height) / state.height,
    );
    await tapRemote(page, x, y);
    expect(await remote.locator('[name="password"]').inputValue()).toBe("");
    expect(await remote.locator("body").getAttribute("data-submitted")).toBeNull();
    expect(controls.map((command) => JSON.parse(command).action)).not.toContain("click");
    releasePrepare();
    await expect
      .poll(() => remote.locator('[name="password"]').inputValue())
      .toBe("test-local-password");
    expect(await remote.locator('[name="username"]').inputValue()).toBe("test-manager-user");
    expect(await password.inputValue()).toBe("test-local-password");
    await page.setViewportSize({ width: 390, height: 430 });
    await expectCompactAddressRow(page);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.evaluate(() => navigator.clipboard.writeText("test-corrected-password"));
    await password.press("ControlOrMeta+a");
    await password.press("ControlOrMeta+v");
    const retry = panel.getByRole("button", { name: "Retry" });
    await retry.waitFor();
    expect(await password.inputValue()).toBe("test-corrected-password");
    await retry.focus();
    // Focus is on the Retry button when the mobile keyboard is dismissed, not an input.
    // The remote frame geometry must not change and discard the local login form.
    const beforeRetry = await service.cloudState(attachedBrowserId);
    await page.setViewportSize({ width: 390, height: 480 });
    await expect
      .poll(() =>
        page.locator(".browser-popover").evaluate((node) => node.getBoundingClientRect().bottom),
      )
      .toBeGreaterThan(430);
    await retry.press("Enter");
    expect(await password.evaluate((node) => node === document.activeElement)).toBe(true);
    await expect
      .poll(() => remote.locator('[name="password"]').inputValue(), { timeout: 10_000 })
      .toBe("test-corrected-password");
    const keyboardBounds = (await password.boundingBox())!;
    expect(keyboardBounds.y + keyboardBounds.height).toBeLessThanOrEqual(480);
    expect((await service.cloudState(attachedBrowserId)).revision).toBe(beforeRetry.revision);
    await password.press("Enter");
    expect(await remote.locator("body").getAttribute("data-submitted")).toBeNull();
    expect(controls.join("\n")).not.toMatch(/test-(?:local|corrected)-password/);
    const { revision: compactRevision } = await fittedViewerFrame(page);
    await username.fill("test-manager-user");
    await page.clock.install();
    await page.setViewportSize({ width: 390, height: 844 });
    await username.blur();
    await page.clock.runFor(350);
    expect((await service.cloudState(attachedBrowserId)).revision).toBe(compactRevision);
    expect(await username.inputValue()).toBe("test-manager-user");
    await password.fill("test-corrected-password");
    await page.clock.runFor(350);
    await page.getByRole("status", { name: "Filling remote login" }).waitFor({ state: "hidden" });
    const gap = () =>
      page.locator(".cloud-browser__image").evaluate((canvas) => {
        const panel = canvas.closest(".cloud-browser")!.querySelector(".browser-credentials")!;
        return panel.getBoundingClientRect().top - canvas.getBoundingClientRect().bottom;
      });
    expect(await gap()).toBeGreaterThan(50);
    await password.fill("");
    await password.blur();
    await page.clock.runFor(350);
    expect((await service.cloudState(attachedBrowserId)).revision).toBe(compactRevision);
    expect(await gap()).toBeGreaterThan(50);
    const compactSignIn = (await remote.getByRole("button", { name: "Sign in" }).boundingBox())!;
    await tapRemote(
      page,
      compactSignIn.x + compactSignIn.width / 2,
      compactSignIn.y + compactSignIn.height / 2,
    );
    expect(await remote.locator("body").getAttribute("data-submitted")).toBeNull();
    await password.fill("test-corrected-password");
    await password.blur();
    await page.clock.runFor(350);
    const readyState = await fittedViewerFrame(page);
    expect(Math.abs(await gap())).toBeLessThanOrEqual(2);
    const readyCanvas = (await page.locator(".cloud-browser__image").boundingBox())!;
    const readySignIn = (await remote.getByRole("button", { name: "Sign in" }).boundingBox())!;
    await page.mouse.click(
      readyCanvas.x +
        ((readySignIn.x + readySignIn.width / 2) * readyCanvas.width) / readyState.width,
      readyCanvas.y +
        ((readySignIn.y + readySignIn.height / 2) * readyCanvas.height) / readyState.height,
    );
    await expect
      .poll(() => controls.map((command) => JSON.parse(command).action))
      .toContain("click");
    await expect.poll(() => remote.locator("body").getAttribute("data-submitted")).toBe("yes");
    await page.locator('.browser-credentials [name="password"]').fill("discard-on-step-change");
    await remote.setContent(
      '<form action="/ax/claim"><input type="email" name="email"><button>Continue</button></form>',
    );
    await expect
      .poll(() => page.locator('.browser-credentials [name="password"]').inputValue())
      .toBe("");
    await expect
      .poll(() => page.locator('.browser-credentials [name="password"]').getAttribute("required"))
      .toBeNull();
    await page.locator('.browser-credentials [name="username"]').fill("multistep-user");
    await expect.poll(() => remote.locator('[name="email"]').inputValue()).toBe("multistep-user");
    await remote.setContent(
      '<form><input type="password" autocomplete="current-password"><button>Sign in</button></form>',
    );
    await expect
      .poll(() => page.locator('.browser-credentials [name="username"]').inputValue())
      .toBe("");
    await expect
      .poll(() => page.locator('.browser-credentials [name="username"]').getAttribute("required"))
      .toBeNull();
    await expect
      .poll(() => page.locator('.browser-credentials [name="password"]').getAttribute("required"))
      .not.toBeNull();
    await page.locator('.browser-credentials [name="password"]').fill("multistep-password");
    await expect.poll(() => remote.locator("input").inputValue()).toBe("multistep-password");
    await remote.setContent('<form><input type="email"><button>Subscribe</button></form>');
    await page.locator(".browser-credentials").waitFor({ state: "detached", timeout: 10_000 });
  } finally {
    await context.close();
  }
}, 30_000);

async function expectCompactAddressRow(page: Page) {
  const address = page.getByRole("textbox", { name: "Browser address" });
  const addressBounds = (await address.boundingBox())!;
  const names = ["Go back", "Reload page", "Choose tab", "Close popover"];
  for (const name of names) {
    const buttonBounds = (await page.getByRole("button", { name, exact: true }).boundingBox())!;
    expect(
      Math.abs(
        buttonBounds.y + buttonBounds.height / 2 - addressBounds.y - addressBounds.height / 2,
      ),
    ).toBeLessThan(1);
  }
  expect(addressBounds.width).toBeGreaterThan(0);
  expect(addressBounds.x + addressBounds.width).toBeLessThanOrEqual(page.viewportSize()!.width);
}

async function inspect(script: string) {
  // Read the same live page without an agent action invalidating its revision.
  return (await service.cloudTarget(attachedBrowserId)).page.evaluate(
    // eslint-disable-next-line no-eval -- Read-only assertions inspect the page's main world.
    (source) => globalThis.eval(source),
    script,
  );
}
async function fittedViewerFrame(page: Page) {
  // Remote viewport changes precede encoder restart and the viewer's next paint.
  // Wait for geometry, revision and decoded bitmap together, not just any frame.
  let fitted!: Awaited<ReturnType<typeof service.cloudState>>;
  await expect
    .poll(
      async () => {
        const state = await service.cloudState(attachedBrowserId);
        const ready = await page
          .locator(".cloud-browser__image")
          .evaluate((canvas: HTMLCanvasElement, state) => {
            const viewport = canvas.parentElement!.getBoundingClientRect();
            const width = Math.round(viewport.width);
            const height = Math.round(viewport.height);
            const ratio = Math.min(1, 1365 / Math.max(width, height));
            return (
              state.width === Math.round(width * ratio) &&
              state.height === Math.round(height * ratio) &&
              canvas.dataset.frame !== undefined &&
              canvas.dataset.revision === state.revision &&
              canvas.width === Math.ceil((state.width * state.deviceScaleFactor) / 2) * 2 &&
              canvas.height === Math.ceil((state.height * state.deviceScaleFactor) / 2) * 2
            );
          }, state);
        if (ready) fitted = state;
        return ready;
      },
      { timeout: 10_000 },
    )
    .toBe(true);
  return fitted;
}
async function tapRemote(page: Page, x: number, y: number) {
  const image = page.locator(".cloud-browser__image");
  const state = await service.cloudState(attachedBrowserId);
  await expect.poll(() => image.getAttribute("data-revision")).toBe(state.revision);
  const bounds = (await image.boundingBox())!;
  await page.touchscreen.tap(
    bounds.x + (x * bounds.width) / state.width,
    bounds.y + (y * bounds.height) / state.height,
  );
}
async function swipe(page: Page, x: number, y: number, distance: number, steps = 5, delay = 35) {
  const image = page.locator(".cloud-browser__image");
  const state = await service.cloudState(attachedBrowserId);
  await expect.poll(() => image.getAttribute("data-revision")).toBe(state.revision);
  const bounds = (await image.boundingBox())!;
  const px = bounds.x + (x * bounds.width) / state.width;
  const py = bounds.y + (y * bounds.height) / state.height;
  const touch = await page.context().newCDPSession(page);
  try {
    // CDP acknowledgements/compositor scheduling can stall under full-suite CPU
    // load. Keep the simulated finger's clock independent of dispatch latency.
    const started = Date.now();
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: px, y: py }],
      timestamp: started / 1000,
    });
    for (let step = 1; step <= steps; step++) {
      const remaining = started + step * delay - Date.now();
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: px, y: py - (distance * step) / steps }],
        timestamp: (started + step * delay) / 1000,
      });
    }
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
      timestamp: (started + steps * delay + 1) / 1000,
    });
  } finally {
    await touch.detach();
  }
}

test("mobile live session fits its viewport and edits the focused remote field", async () => {
  await service.execute("integration", {
    action: "open",
    url: `${backendUrl}/target`,
    cloud: true,
  });
  attachedBrowserId = (await service.execute("integration", { action: "attach" })).details
    .sites![0]!.browserId!;
  const context = await browser.newContext({
    permissions: ["local-network-access"],
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
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
    await expect.poll(() => image.count(), { timeout: 10_000 }).toBe(1);
    const remote = await fittedViewerFrame(page);
    expect(remote.mobile).toBe(true);
    expect(remote.deviceScaleFactor).toBe(1);
    expect(await image.evaluate((e: HTMLCanvasElement) => [e.width, e.height])).toEqual([
      Math.ceil(remote.width / 2) * 2,
      Math.ceil(remote.height / 2) * 2,
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
    const addressWidth = (await addressInput.boundingBox())!.width;
    const inputHeight = (await addressInput.boundingBox())!.height;
    expect((await popover.getByRole("button", { name: "Go back" }).boundingBox())!.height).toBe(
      inputHeight,
    );
    await addressInput.tap();
    for (const name of ["Go back", "Reload page", "Choose tab"]) {
      await popover.getByRole("button", { name, exact: true }).waitFor({ state: "hidden" });
    }
    expect((await addressInput.boundingBox())!.width).toBeGreaterThan(addressWidth + 100);
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
    await addressInput.blur();
    for (const name of ["Go back", "Reload page", "Choose tab"]) {
      await popover.getByRole("button", { name, exact: true }).waitFor({ state: "visible" });
    }
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
    await expect
      .poll(async () => Math.abs((await image.boundingBox())!.height - remote.height))
      .toBeLessThan(1);
    await popover.getByRole("button", { name: "Close popover" }).click();
    expect(await service.hasSession("integration")).toBe(true);
  } finally {
    await context.close();
  }
}, 60_000);

test("native touch drag and cancellation survive rotation and disconnect", async () => {
  await service.execute("integration", { action: "open", url: `${backendUrl}/touch`, cloud: true });
  attachedBrowserId = (await service.execute("integration", { action: "attach" })).details
    .sites![0]!.browserId!;
  const context = await browser.newContext({
    permissions: ["local-network-access"],
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
  });
  await context.addCookies([
    { name: "cloud-auth", value: "test", url: server.resolvedUrls!.local[0]! },
  ]);
  const page = await context.newPage();
  const touch = await context.newCDPSession(page);
  try {
    await page.goto(url);
    await page.getByRole("button", { name: "Open browser", exact: true }).click();
    const canvas = page.locator(".cloud-browser__image");
    await expect.poll(() => canvas.getAttribute("data-frame")).not.toBeNull();
    await tapRemote(page, 40, 25);
    await expect.poll(() => inspect("document.body.dataset.clicks")).toBe("1");
    // A touch-action:none surface receives touch-driven pointer movement, not page scrolling.
    await swipe(page, 340, 400, 120);
    await expect
      .poll(() => inspect("Number(document.querySelector('#drag').dataset.moves||0)"))
      .toBeGreaterThan(2);
    expect(await inspect("scrollY")).toBe(0);
    const send = async (type: "touchStart" | "touchMove" | "touchCancel", x = 200, y = 300) => {
      const bounds = (await canvas.boundingBox())!;
      await touch.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: type === "touchCancel" ? [] : [{ x: bounds.x + x, y: bounds.y + y }],
      });
    };
    await send("touchStart");
    await send("touchMove", 200, 270);
    await send("touchCancel");
    await expect.poll(() => inspect("Number(document.body.dataset.cancels||0)")).toBeGreaterThan(0);
    // Rotation cancels a held remote finger before changing the coordinate system.
    const cancels = Number(await inspect("document.body.dataset.cancels"));
    const startsBeforeRotation = Number(await inspect("document.body.dataset.starts"));
    await send("touchStart");
    // Local CDP dispatch does not acknowledge delivery through the viewer socket.
    // Hold an actual remote finger before testing that rotation cancels it.
    await expect
      .poll(() => inspect("Number(document.body.dataset.starts)"))
      .toBeGreaterThan(startsBeforeRotation);
    await page.setViewportSize({ width: 844, height: 390 });
    await expect
      .poll(async () => (await service.cloudState(attachedBrowserId)).width)
      .toBeGreaterThan(750);
    await expect
      .poll(() => inspect("Number(document.body.dataset.cancels)"))
      .toBeGreaterThan(cancels);
    await send("touchCancel");
    // Closing the viewer cancels a touch without closing the browser or its page.
    const beforeClose = Number(await inspect("document.body.dataset.cancels"));
    const starts = Number(await inspect("document.body.dataset.starts"));
    // Rotation can publish intermediate revisions while layout and encoding settle.
    // Compare the current remote state and decoded frame together, not a revision
    // sampled once before the poll starts.
    await fittedViewerFrame(page);
    await send("touchStart", 200, 100);
    await expect
      .poll(() => inspect("Number(document.body.dataset.starts)"))
      .toBeGreaterThan(starts);
    const remotePage = (await service.cloudTarget(attachedBrowserId)).page;
    await page.getByRole("button", { name: "Close popover" }).click();
    await expect
      .poll(() => inspect("Number(document.body.dataset.cancels)"))
      .toBeGreaterThan(beforeClose);
    expect(remotePage.isClosed()).toBe(false);
  } finally {
    await touch.detach();
    await context.close();
  }
}, 60_000);

test("DPR3 frames cover all viewport corners and align edge taps", async () => {
  await service.execute("integration", {
    action: "open",
    url: `${backendUrl}/coverage`,
    cloud: true,
  });
  attachedBrowserId = (await service.execute("integration", { action: "attach" })).details
    .sites![0]!.browserId!;
  const context = await browser.newContext({
    permissions: ["local-network-access"],
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
    await fittedViewerFrame(page);
    const original = await service.cloudTarget(attachedBrowserId);
    await expect.poll(() => canvas.getAttribute("data-revision")).toBe(original.state.revision);
    // A large bitmap is insufficient: all four viewport corners must contain the page.
    await expect.poll(colors).toEqual(expected);
    expect(
      await canvas.evaluate((element: HTMLCanvasElement) => [element.width, element.height]),
    ).toEqual([
      Math.ceil((original.state.width * 3) / 2) * 2,
      Math.ceil((original.state.height * 3) / 2) * 2,
    ]);
    await tapRemote(page, original.state.width * 0.875, original.state.height * 0.85);
    await expect.poll(() => inspect("document.body.dataset.clicks")).toBe("1");
    expect((await service.cloudTarget(attachedBrowserId)).page).toBe(original.page);
    await page.getByRole("button", { name: "Close popover" }).click();
  } finally {
    await context.close();
  }
}, 60_000);
