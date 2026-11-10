// @vitest-environment node
import path from "node:path";
import { WebSocketServer } from "ws";
import { RpcChannel } from "@/shared/rpc";
import { chromium, type Browser } from "playwright-core";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { closeBrowserFixtureServer, createBrowserFixtureServer } from "../test/browser-fixture";

let chrome: Browser;
let server: ViteDevServer;
let sockets: WebSocketServer;
let url: string;
let stall = false;
let delayUpgrade = 0;
let upgrades = 0;
const requests: { operation: string; input: unknown }[] = [];
const channels = new Set<RpcChannel>();

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
              upgrades++;
              const delay = delayUpgrade;
              delayUpgrade = 0;
              setTimeout(() => {
                if (socket.destroyed) return;
                sockets.handleUpgrade(request, socket, head, (websocket) => {
                  const channel = new RpcChannel(websocket, {
                    handle: async (operation, input, context) => {
                      requests.push({ operation, input });
                      // Leave the first logical stream waiting for headers during recovery.
                      if (stall) {
                        stall = false;
                        return new Promise<never>((_, reject) => {
                          context.signal.addEventListener(
                            "abort",
                            () => reject(context.signal.reason),
                            { once: true },
                          );
                        });
                      }
                      let timer: ReturnType<typeof setInterval>;
                      return {
                        value: null,
                        events: new ReadableStream<unknown>({
                          start(controller) {
                            controller.enqueue({ cursor: "2" });
                            timer = setInterval(
                              () => controller.enqueue({ type: "heartbeat" }),
                              1000,
                            );
                          },
                          cancel() {
                            clearInterval(timer);
                          },
                        }),
                      };
                    },
                  });
                  channels.add(channel);
                  void channel.closed.then(() => channels.delete(channel));
                });
              }, delay);
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
}, 30_000);

afterAll(async () => {
  await chrome?.close();
  for (const channel of channels) channel.close();
  sockets?.close();
  if (server) await closeBrowserFixtureServer(server);
});

test("Chromium allows a WebSocket upgrade to finish after the session watchdog ticks", async () => {
  requests.length = 0;
  upgrades = 0;
  delayUpgrade = 6000;
  const page = await chrome.newPage();
  try {
    await page.goto(url);
    await expect
      .poll(() => page.locator("output").textContent(), { timeout: 10_000 })
      .toBe("online");
    expect(upgrades).toBe(1);
    expect(requests).toHaveLength(1);
    expect(await page.locator("textarea").inputValue()).toBe("unsent draft");
  } finally {
    await page.close();
  }
});

test("Chromium retries stalled socket stream handshakes without losing a draft", async () => {
  requests.length = 0;
  stall = true;
  const page = await chrome.newPage();
  try {
    await page.clock.install();
    await page.clock.pauseAt(Date.now());
    await page.goto(url);
    await expect.poll(() => requests.length).toBe(1);
    // Keep real WebSocket streaming and browser state; advance only the handshake timer.
    await page.clock.fastForward(5000);
    // Resume transport drain timers; only the stalled handshake is time-skipped.
    await page.clock.resume();
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
});
