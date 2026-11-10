// @vitest-environment node
import http from "node:http";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { build } from "vite";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

let browser: Browser;
let server: http.Server;
let origin: string;
let workerSource: string;
let revision = 1;
const installs = ["/", "/batty", "/batty-safe", "/nested/app", "/batty/nested"];
const scope = (base: string) => `${origin}${base === "/" ? "/" : `${base}/`}`;
const namespace = (base: string) => `batty:${encodeURIComponent(scope(base))}:`;
const appPath = (base: string, suffix: string) => `${base === "/" ? "" : base}${suffix}`;

// Invoke the real notification handler inside a live extendable message event.
// Chromium does not expose an API for clicking an OS notification in headless tests.
const notificationHarness = `
let notificationClick;
// focus() requires a trusted OS notification gesture; navigation and client selection stay native.
WindowClient.prototype.focus = async function () { return this; };
const addListener = self.addEventListener.bind(self);
self.addEventListener = (type, listener, options) => {
  if (type === 'notificationclick') notificationClick = listener;
  addListener(type, listener, options);
};
addListener('message', event => {
  if (event.data?.type !== '__test_notification_click') return;
  notificationClick({
    preventDefault() {},
    notification: { close() {}, data: { url: event.data.url } },
    waitUntil(promise) {
      event.waitUntil(promise.then(
        () => event.ports[0].postMessage({ ok: true }),
        error => event.ports[0].postMessage({ error: String(error) })
      ));
    }
  });
});
`;

beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: "error",
    resolve: { alias: { "@": path.resolve("src") } },
    define: { "self.__WB_MANIFEST": "[]", "process.env.NODE_ENV": '"production"' },
    build: {
      write: false,
      minify: false,
      lib: { entry: path.resolve("src/client/sw.ts"), formats: ["es"] },
    },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!output || !("output" in output)) throw new Error("Expected a service-worker bundle");
  const chunk = output.output.find((entry) => entry.type === "chunk");
  if (!chunk || chunk.type !== "chunk") throw new Error("Missing service-worker bundle");
  workerSource = notificationHarness + chunk.code;
  server = http.createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    const base = [...installs]
      .sort((a, b) => b.length - a.length)
      .find((candidate) => candidate === "/" || url.pathname.startsWith(`${candidate}/`))!;
    response.setHeader("Cache-Control", "no-store");
    if (url.pathname.endsWith("/sw.js")) {
      response.setHeader("Content-Type", "text/javascript");
      response.end(`${workerSource}\nself.fixtureRevision = ${revision};`);
    } else if (url.pathname.includes("/api/")) {
      response.setHeader("Content-Type", "text/plain");
      response.end(`private ${base}`);
    } else if (url.pathname.includes("/assets/")) {
      response.setHeader("Content-Type", "text/plain");
      response.end(`asset ${base}`);
    } else {
      response.setHeader("Content-Type", "text/html");
      response.end(`<!doctype html><title>${base}</title><body>${base}</body>`);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  if (server)
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

async function install(context: BrowserContext, base: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(scope(base));
  await page.evaluate(
    async (sw) => {
      const registration = await navigator.serviceWorker.register(sw);
      if (registration.active?.state !== "activated") {
        await new Promise<void>((resolve) => {
          const worker = registration.installing ?? registration.waiting ?? registration.active!;
          worker.addEventListener("statechange", () => {
            if (worker.state === "activated") resolve();
          });
        });
      }
    },
    appPath(base, "/sw.js"),
  );
  await page.waitForFunction(
    (sw) => navigator.serviceWorker.controller?.scriptURL === sw,
    `${origin}${appPath(base, "/sw.js")}`,
  );
  return page;
}

async function send(page: Page, message: Record<string, unknown>, workerBase?: string) {
  return page.evaluate(
    async ({ message, workerScope }) => {
      const worker = workerScope
        ? (await navigator.serviceWorker.getRegistration(workerScope))!.active!
        : navigator.serviceWorker.controller!;
      return new Promise((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = (event) => resolve(event.data);
        worker.postMessage(message, [channel.port2]);
      });
    },
    { message, workerScope: workerBase === undefined ? undefined : scope(workerBase) },
  );
}

async function authorize(page: Page, base: string) {
  await page.evaluate(() => {
    navigator.serviceWorker.controller!.postMessage({
      type: "authorize-private-previews",
      scope: "same-user-and-epoch",
      cacheEpoch: "epoch",
      expiresAt: Date.now() + 60_000,
    });
  });
  await expect
    .poll(() =>
      page.evaluate(
        async (name) => {
          const cache = await caches.open(name);
          return (await cache.keys()).length;
        },
        `${namespace(base)}private-image-previews:permissions`,
      ),
    )
    .toBe(2);
}

test("same-origin installs keep caches, preview permissions, locks and controller ownership independent", async () => {
  const context = await browser.newContext();
  try {
    // Start nested registrations first: activating/claiming the root must not steal their clients.
    const pages = new Map<string, Page>();
    for (const base of [...installs.slice(1), "/"]) pages.set(base, await install(context, base));
    for (const [base, page] of pages) {
      expect(await page.evaluate(() => navigator.serviceWorker.controller!.scriptURL)).toBe(
        `${origin}${appPath(base, "/sw.js")}`,
      );
      await authorize(page, base);
      expect(
        await page.evaluate(
          (url) => fetch(url).then((r) => r.text()),
          appPath(base, "/api/image?preview=1"),
        ),
      ).toBe(`private ${base}`);
      await page.evaluate((url) => fetch(url), appPath(base, "/assets/app.txt"));
    }
    const root = pages.get("/")!;
    // Fetch completion precedes the service worker's event.waitUntil cache writes.
    await expect
      .poll(() => root.evaluate(() => caches.keys()))
      .toEqual(
        expect.arrayContaining(
          installs.flatMap((base) => [
            `${namespace(base)}app-shell`,
            `${namespace(base)}static-assets`,
            `${namespace(base)}private-image-previews:same-user-and-epoch`,
          ]),
        ),
      );

    // A lock held by one installation must not block a different installation's logout.
    await root.evaluate(
      (name) => {
        (window as any).heldLock = navigator.locks.request(name, async () => {
          (window as any).lockHeld = true;
          await new Promise((resolve) => {
            (window as any).releaseLock = resolve;
          });
        });
      },
      `${namespace("/")}private-previews`,
    );
    await root.waitForFunction(() => (window as any).lockHeld);
    expect(
      await send(pages.get("/batty")!, {
        type: "clear-private-previews",
        cacheEpoch: "logged-out",
      }),
    ).toEqual({ ok: true });
    await root.evaluate(async () => {
      (window as any).releaseLock();
      await (window as any).heldLock;
    });
    const remaining = await root.evaluate(() => caches.keys());
    expect(remaining).not.toContain(
      `${namespace("/batty")}private-image-previews:same-user-and-epoch`,
    );
    for (const base of installs.filter((base) => base !== "/batty")) {
      expect(remaining).toContain(`${namespace(base)}private-image-previews:same-user-and-epoch`);
    }
    // A page can explicitly address another registration, but cannot revoke its permissions.
    expect(
      await send(
        root,
        { type: "clear-private-previews", cacheEpoch: "wrong-install" },
        "/batty-safe",
      ),
    ).toEqual({ error: "Error: Private preview message is outside this installation" });
    expect(await root.evaluate(() => caches.keys())).toContain(
      `${namespace("/batty-safe")}private-image-previews:same-user-and-epoch`,
    );

    // Offline navigation uses each installation's own cached shell.
    await context.setOffline(true);
    for (const [base, page] of pages) {
      await page.reload();
      expect(await page.title()).toBe(base);
    }
  } finally {
    await context.close();
  }
}, 30_000);

test.each([
  ["/", "/batty"],
  ["/batty", "/batty/nested"],
])(
  "first visit to %s's child %s cannot poison its parent shell or revoke parent previews",
  async (parentBase, childBase) => {
    const context = await browser.newContext();
    try {
      const parent = await install(context, parentBase);
      await authorize(parent, parentBase);
      await parent.evaluate((url) => fetch(url), appPath(parentBase, "/api/image?preview=1"));
      const child = await context.newPage();
      await child.goto(scope(childBase));
      expect(await child.title()).toBe(childBase);
      expect(await child.evaluate(() => navigator.serviceWorker.controller!.scriptURL)).toBe(
        `${origin}${appPath(parentBase, "/sw.js")}`,
      );
      expect(
        await send(child, { type: "clear-private-previews", cacheEpoch: "wrong-parent" }),
      ).toEqual({ error: "Error: Private preview message is outside this installation" });
      const cached = await parent.evaluate(
        async ({ cacheName, shell }) => {
          const cache = await caches.open(cacheName);
          return (await cache.match(shell))!.text();
        },
        {
          cacheName: `${namespace(parentBase)}app-shell`,
          shell: appPath(parentBase, "/index.html"),
        },
      );
      expect(cached).toContain(`<title>${parentBase}</title>`);
      expect(await parent.evaluate(() => caches.keys())).toContain(
        `${namespace(parentBase)}private-image-previews:same-user-and-epoch`,
      );
      await context.setOffline(true);
      await parent.reload();
      expect(await parent.title()).toBe(parentBase);
    } finally {
      await context.close();
    }
  },
);

test("root worker upgrade cleans only its own obsolete precaches and preserves nested controllers", async () => {
  const context = await browser.newContext();
  try {
    const nested = await install(context, "/batty");
    const root = await install(context, "/");
    const oldOwn = `${namespace("/")}-precache-v1`;
    const foreign = `${namespace("/batty")}-precache-v1`;
    const legacyForeign = `workbox-precache-v1-${scope("/batty")}`;
    await root.evaluate(
      async (names) => {
        for (const name of names) await caches.open(name);
      },
      [oldOwn, foreign, legacyForeign],
    );
    revision += 1;
    await root.evaluate(async () => {
      const oldController = navigator.serviceWorker.controller;
      const changed = new Promise<void>((resolve) =>
        navigator.serviceWorker.addEventListener("controllerchange", () => {
          if (navigator.serviceWorker.controller !== oldController) resolve();
        }),
      );
      await (await navigator.serviceWorker.getRegistration())!.update();
      await changed;
    });
    await expect
      .poll(() => root.evaluate(() => caches.keys()), { timeout: 10_000 })
      .not.toContain(oldOwn);
    const names = await root.evaluate(() => caches.keys());
    expect(names).toContain(foreign);
    expect(names).toContain(legacyForeign);
    expect(await nested.evaluate(() => navigator.serviceWorker.controller!.scriptURL)).toBe(
      `${origin}/batty/sw.js`,
    );
  } finally {
    await context.close();
  }
}, 30_000);

test("notification clicks notify and navigate only clients controlled by their own registration", async () => {
  const context = await browser.newContext();
  try {
    const other = await install(context, "/batty-safe");
    const root = await install(context, "/");
    const target = await install(context, "/batty");
    for (const page of [other, root]) {
      await page.evaluate(() => {
        (window as any).notifications = [];
        navigator.serviceWorker.addEventListener("message", (event) =>
          (window as any).notifications.push(event.data),
        );
      });
    }
    await send(
      other,
      { type: "__test_notification_click", url: "/batty/?notification=1" },
      "/batty",
    );
    await expect.poll(() => target.url()).toBe(`${origin}/batty/?notification=1`);
    expect(root.url()).toBe(`${origin}/`);
    expect(other.url()).toBe(`${origin}/batty-safe/`);
    for (const page of [other, root])
      expect(await page.evaluate(() => (window as any).notifications)).toEqual([]);
    // Root notifications must not notify/navigate the nested client either.
    await send(other, { type: "__test_notification_click", url: "/?notification=2" }, "/");
    expect(target.url()).toBe(`${origin}/batty/?notification=1`);
    expect(other.url()).toBe(`${origin}/batty-safe/`);
  } finally {
    await context.close();
  }
}, 30_000);
