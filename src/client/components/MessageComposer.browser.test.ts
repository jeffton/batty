// @vitest-environment node
import path from "node:path";
import vue from "@vitejs/plugin-vue";
import { chromium, type Browser } from "patchright";
import type { ViteDevServer } from "vite";
import { closeBrowserFixtureServer, createBrowserFixtureServer } from "../test/browser-fixture";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

let server: ViteDevServer;
let browser: Browser;
let url: string;

beforeAll(async () => {
  server = await createBrowserFixtureServer("src/client/components/MessageComposer.fixture.html", {
    plugins: [vue()],
    define: { __BATTY_BUILD_ID__: JSON.stringify("dev") },
    resolve: { alias: { "@": path.resolve("src") } },
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  url = `${server.resolvedUrls!.local[0]}src/client/components/MessageComposer.fixture.html`;
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  if (server) await closeBrowserFixtureServer(server);
});

test("composer controls keep their slots when tasks and main finish", async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 900 } });
  try {
    await page.goto(url + "?streaming&tasks");
    await page.getByRole("button", { name: "Send prompt" }).waitFor();
    const positions = async () =>
      Promise.all(
        ["Add files", "Stop", "Send prompt"].map((name) =>
          page.getByRole("button", { name, exact: true }).boundingBox(),
        ),
      );
    const before = await positions();
    const tasks = await page
      .getByRole("button", { name: "Running tasks", exact: true })
      .boundingBox();
    await page.evaluate(() => window.dispatchEvent(new Event("fixture:finish-agent")));
    await page
      .getByRole("button", { name: "Running tasks", exact: true })
      .waitFor({ state: "detached" });
    expect(await positions()).toEqual(before);
    const stop = await page.getByRole("button", { name: "Stop", exact: true }).boundingBox();
    expect(stop!.x).toBeGreaterThanOrEqual(tasks!.x + tasks!.width);
    await page.evaluate(() => window.dispatchEvent(new Event("fixture:finish-main")));
    await page.getByRole("button", { name: "Stop", exact: true }).waitFor({ state: "detached" });
    expect(await page.getByRole("button", { name: "Add files" }).boundingBox()).toEqual(before[0]);
    expect(await page.getByRole("button", { name: "Send prompt" }).boundingBox()).toEqual(
      before[2],
    );
  } finally {
    await page.close();
  }
}, 30_000);
