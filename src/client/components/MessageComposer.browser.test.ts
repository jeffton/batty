// @vitest-environment node
import path from "node:path";
import vue from "@vitejs/plugin-vue";
import { chromium, type Browser } from "patchright";
import { webkit, type Page } from "playwright-core";
import type { ViteDevServer } from "vite";
import { closeBrowserFixtureServer, createBrowserFixtureServer } from "../test/browser-fixture";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

let server: ViteDevServer;
let browser: Browser;
let webkitBrowser: Awaited<ReturnType<typeof webkit.launch>>;
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
  webkitBrowser = await webkit.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await webkitBrowser?.close();
  if (server) await closeBrowserFixtureServer(server);
});

test.each(["Chromium", "WebKit"])(
  "%s composer owns its labeled textarea without changing newline, composition or send behavior",
  async (engine) => {
    const page = (await (engine === "Chromium" ? browser : webkitBrowser).newPage()) as Page;
    try {
      await page.goto(url);
      const input = page.getByRole("textbox", { name: "Chat message", exact: true });
      await input.waitFor();
      expect(
        await input.evaluate((element: HTMLTextAreaElement) => ({
          form: element.form?.className,
          labels: Array.from(element.labels ?? [], (label) => label.textContent),
        })),
      ).toEqual({ form: "composer", labels: ["Chat message"] });
      await input.fill("First line");
      await input.press("Enter");
      await input.press("Shift+Enter");
      await input.dispatchEvent("compositionstart", { data: "あ" });
      await input.dispatchEvent("keydown", { key: "Enter", isComposing: true });
      await input.dispatchEvent("compositionend", { data: "あ" });
      expect(await input.inputValue()).toBe("First line\n\n");
      const submissions = async () =>
        JSON.parse((await page.locator("#submissions").textContent())!);
      expect(await submissions()).toEqual([]);
      await input.fill("Send this");
      await input.press("Control+Enter");
      await input.press("Meta+Enter");
      await page.getByRole("button", { name: "Send prompt", exact: true }).click();
      expect(await submissions()).toEqual(["Send this", "Send this", "Send this"]);
      // Native form submission stays in the SPA and uses the same guarded send action.
      await input.evaluate((element: HTMLTextAreaElement) => element.form!.requestSubmit());
      expect(await submissions()).toHaveLength(4);
      expect(page.url()).toBe(url);
    } finally {
      await page.close();
    }
  },
  30_000,
);

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
