// @vitest-environment node
import path from "node:path";
import { WebSocketServer } from "ws";
import { SocketChannel } from "@/shared/socket-channel";
import { chromium, type Browser } from "playwright-core";
import { launchWebKit } from "../test/webkit";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { closeBrowserFixtureServer, createBrowserFixtureServer } from "../test/browser-fixture";

let chrome: Browser;
let safari: Browser;
let server: ViteDevServer;
let sockets: WebSocketServer;
let url: string;
let stall = false;
const requests: string[] = [];
const channels = new Set<SocketChannel>();

beforeAll(async () => {
  server = await createBrowserFixtureServer(
    "src/client/lib/SessionConnection.fixture.html",
    {
      resolve: { alias: { "@": path.resolve("src") } },
      server: { host: "127.0.0.1", port: 0 },
      plugins: [
        {
          name: "wake-events",
          configureServer(server) {
            sockets = new WebSocketServer({ noServer: true });
            server.httpServer!.on("upgrade", (request, socket, head) => {
              if (request.url !== "/api/socket") return;
              sockets.handleUpgrade(request, socket, head, (websocket) => {
                const channel = new SocketChannel(websocket, {
                  handle: async (path, request) => {
                    requests.push(path);
                    // Leave the first logical stream waiting for headers during recovery.
                    if (stall) {
                      stall = false;
                      return new Promise<Response>((_, reject) => {
                        request.signal.addEventListener(
                          "abort",
                          () => reject(request.signal.reason),
                          { once: true },
                        );
                      });
                    }
                    const encoder = new TextEncoder();
                    let timer: ReturnType<typeof setInterval>;
                    return new Response(
                      new ReadableStream<Uint8Array>({
                        start(controller) {
                          controller.enqueue(encoder.encode('data: {"cursor":"2"}\n\n'));
                          timer = setInterval(
                            () =>
                              controller.enqueue(encoder.encode("event: heartbeat\ndata: {}\n\n")),
                            1000,
                          );
                        },
                        cancel() {
                          clearInterval(timer);
                        },
                      }),
                      { headers: { "Content-Type": "text/event-stream" } },
                    );
                  },
                });
                channels.add(channel);
                void channel.closed.then(() => channels.delete(channel));
              });
            });
          },
        },
      ],
    },
    { socket: false },
  );
  await server.listen();
  url = `${server.resolvedUrls!.local[0]}src/client/lib/SessionConnection.fixture.html`;
  chrome = await chromium.launch({ headless: true });
  safari = await launchWebKit();
}, 30_000);

afterAll(async () => {
  await chrome?.close();
  await safari?.close();
  for (const channel of channels) channel.close();
  sockets?.close();
  if (server) await closeBrowserFixtureServer(server);
});

test.each(["Chromium", "WebKit"])(
  "%s retries stalled socket stream handshakes without losing a draft",
  async (engine) => {
    requests.length = 0;
    stall = true;
    const page = await (engine === "WebKit" ? safari : chrome).newPage();
    try {
      await page.clock.install();
      await page.clock.pauseAt(Date.now());
      await page.goto(url);
      await expect.poll(() => requests.length).toBe(1);
      // Keep real WebSocket streaming and browser state; advance only the handshake timer.
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
    // This exercises suspended tasks and buffered streams, not physical Mac sleep.
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
