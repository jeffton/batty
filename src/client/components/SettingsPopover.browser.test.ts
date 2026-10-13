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
  server = await createBrowserFixtureServer("src/client/components/SettingsPopover.fixture.html", {
    plugins: [vue()],
    define: { __BATTY_BUILD_ID__: JSON.stringify("dev") },
    resolve: { alias: { "@": path.resolve("src") } },
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  url = `${server.resolvedUrls!.local[0]}src/client/components/SettingsPopover.fixture.html`;
  browser = await chromium.launch({ headless: true });
}, 30_000);
afterAll(async () => {
  await browser?.close();
  if (server) await closeBrowserFixtureServer(server);
});

for (const width of [390, 1100]) {
  test(`settings controls, drafts and nested editors at ${width}px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const appearanceRequests: unknown[] = [];
    try {
      await page.route("**/api/**", async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        let body: unknown = {};
        if (pathname.endsWith("/environment")) body = { names: [] };
        if (pathname.endsWith("/appearance")) {
          const appearance = route.request().postDataJSON();
          appearanceRequests.push(appearance);
          body = { appearance };
        }
        if (pathname.includes("assistant-agents")) body = { content: "Workspace instructions" };
        if (pathname.endsWith("/memory/tree")) body = { nodes: [], prepared: 0, total: 0 };
        await route.fulfill({ json: body });
      });
      await page.goto(url);
      const workspace = page.getByRole("combobox", { name: "Assistant workspace", exact: true });
      await workspace.waitFor();
      const controls = await page
        .locator(
          "#settings-Assistant-panel .settings-popover__select, #settings-Assistant-panel .settings-popover__input, #settings-Assistant-panel .model-config-selector__button",
        )
        .evaluateAll((elements) =>
          elements.map((element) => {
            const rect = element.getBoundingClientRect();
            return { left: rect.left, height: rect.height };
          }),
        );
      for (const control of controls) {
        expect(control.left).toBeCloseTo(controls[0]!.left, 0);
        expect(control.height).toBeGreaterThanOrEqual(44);
      }
      for (const name of ["Batty AGENTS.md", "Assistant workspace AGENTS.md", "Memory tree"]) {
        const button = page.getByRole("button", { name, exact: true });
        expect(await button.locator("svg").count()).toBe(1);
        const bounds = await button.boundingBox();
        expect(bounds!.height).toBeGreaterThanOrEqual(44);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      }
      await page.getByRole("button", { name: "Batty AGENTS.md", exact: true }).click();
      const editor = page.getByRole("textbox", { name: "AGENTS.md instructions" });
      await editor.fill("Unsaved global draft");
      await page
        .locator("#settings-agents-editor")
        .getByRole("button", { name: "Close popover" })
        .click();
      await page.getByRole("button", { name: "Assistant workspace AGENTS.md" }).click();
      expect(await editor.inputValue()).toBe("Workspace instructions");
      await page
        .locator("#settings-agents-editor")
        .getByRole("button", { name: "Close popover" })
        .click();
      await page.getByRole("button", { name: "Batty AGENTS.md", exact: true }).click();
      expect(await editor.inputValue()).toBe("Unsaved global draft");
      await page.screenshot({ path: `/tmp/settings-editor-${width}.png` });
      await page
        .locator("#settings-agents-editor")
        .getByRole("button", { name: "Close popover" })
        .click();
      await page.getByRole("button", { name: "Memory tree", exact: true }).click();
      await page.getByText("No prepared memory yet.").waitFor();
      await page
        .locator("#settings-memory-tree")
        .getByRole("button", { name: "Close popover" })
        .click();
      await page.screenshot({ path: `/tmp/settings-b-assistant-${width}.png` });
      await page.getByRole("tab", { name: "Appearance" }).click();
      await page.getByRole("textbox", { name: "App title" }).fill("Unsaved app title");
      await page.getByText("Blue", { exact: true }).click();
      await expect
        .poll(() => page.locator('.settings-popover__color-option[title="Blue"] svg').count())
        .toBe(1);
      await expect
        .poll(() => page.getByRole("button", { name: "Save", exact: true }).isEnabled())
        .toBe(true);
      expect(appearanceRequests).toEqual([{ title: "Batty", color: "blue" }]);
      expect(await page.getByRole("textbox", { name: "App title" }).inputValue()).toBe(
        "Unsaved app title",
      );
      await page.screenshot({ path: `/tmp/settings-b-appearance-${width}.png` });
      const rows = await page.locator(".settings-popover__inline:visible").evaluateAll((elements) =>
        elements.map((element) => {
          const input = element.querySelector("input")!.getBoundingClientRect();
          const button = element.querySelector("button")!.getBoundingClientRect();
          return { right: button.right, gap: button.left - input.right };
        }),
      );
      for (const row of rows) {
        expect(row.right).toBeLessThanOrEqual(width);
        expect(row.gap).toBeGreaterThan(0);
      }
    } finally {
      await page.close();
    }
  });
}
