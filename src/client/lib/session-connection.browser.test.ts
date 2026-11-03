// @vitest-environment node
import path from "node:path";
import type { ServerResponse } from "node:http";
import { chromium, webkit, type Browser } from "playwright-core";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { closeBrowserFixtureServer, createBrowserFixtureServer } from "../test/browser-fixture";

let chrome: Browser;
let safari: Browser;
let server: ViteDevServer;
let url: string;
let stall = false;
const requests: string[] = [];
const responses = new Set<ServerResponse>();

beforeAll(async () => {
  server = await createBrowserFixtureServer("src/client/lib/SessionConnection.fixture.html", {
    resolve: { alias: { "@": path.resolve("src") } },
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "wake-events",
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (!request.url?.startsWith("/wake-events")) return next();
            requests.push(request.url);
            responses.add(response);
            response.on("close", () => responses.delete(response));
            // Leave the first TCP/HTTP request waiting for headers, as during network recovery.
            if (stall) {
              stall = false;
              return;
            }
            response.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
            });
            response.write('data: {"cursor":"2"}\n\n');
            const timer = setInterval(() => response.write("event: heartbeat\ndata: {}\n\n"), 1000);
            response.on("close", () => clearInterval(timer));
          });
        },
      },
    ],
  });
  await server.listen();
  url = `${server.resolvedUrls!.local[0]}src/client/lib/SessionConnection.fixture.html`;
  chrome = await chromium.launch({ headless: true });
  safari = await webkit.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await chrome?.close();
  await safari?.close();
  for (const response of responses) response.destroy();
  if (server) await closeBrowserFixtureServer(server);
});

test.each(["Chromium", "WebKit"])(
  "%s retries stalled HTTP handshakes without losing a draft",
  async (engine) => {
    requests.length = 0;
    stall = true;
    const page = await (engine === "WebKit" ? safari : chrome).newPage();
    try {
      await page.clock.install();
      await page.clock.pauseAt(Date.now());
      await page.goto(url);
      await expect.poll(() => requests.length).toBe(1);
      // Keep real HTTP/SSE and browser state; advance only the handshake timer.
      await page.clock.fastForward(5000);
      await expect
        .poll(() => page.locator("output").textContent(), { timeout: 10_000 })
        .toBe("online");
      expect(requests).toHaveLength(2);
      expect(await page.locator("textarea").inputValue()).toBe("unsent draft");
      await page.evaluate(() => {
        window.dispatchEvent(new Event("focus"));
        document.dispatchEvent(new Event("resume"));
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(requests).toHaveLength(2);
    } finally {
      await page.close();
    }
  },
);

test("Chromium resumes a paused renderer with buffered heartbeats at the latest cursor", async () => {
  requests.length = 0;
  const page = await chrome.newPage();
  try {
    await page.goto(url);
    await expect.poll(() => page.locator("output").textContent()).toBe("online");
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Debugger.enable");
    await cdp.send("Debugger.pause");
    // Pause the actual renderer's JavaScript while the server keeps writing.
    // This exercises suspended tasks and buffered SSE, not physical Mac sleep.
    await new Promise((resolve) => setTimeout(resolve, 11_000));
    const start = Date.now();
    await cdp.send("Debugger.resume");
    await expect.poll(() => requests.length, { timeout: 7000 }).toBe(2);
    expect(Date.now() - start).toBeLessThan(7000);
    expect(requests[1]).toBe("/wake-events?after=2");
    expect(await page.locator("textarea").inputValue()).toBe("unsent draft");
    console.log(`Chromium paused renderer reconnected in ${Date.now() - start}ms`);
    await cdp.detach();
  } finally {
    await page.close();
  }
});
