// @vitest-environment node
import path from "node:path";
import vue from "@vitejs/plugin-vue";
import { chromium, type Browser, type Page } from "patchright";
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

async function expectBoldButtons(page: Page) {
  const weights = await page
    .locator("button:visible")
    .evaluateAll((buttons) => buttons.map((button) => getComputedStyle(button).fontWeight));
  expect(weights.length).toBeGreaterThan(0);
  expect(new Set(weights)).toEqual(new Set(["700"]));
}

for (const width of [390, 1100]) {
  test(`settings controls, drafts and nested editors at ${width}px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const appearanceRequests: unknown[] = [];
    const environmentRequests: unknown[] = [];
    let environmentNames = ["PROJECT_ROOT"];
    try {
      await page.route("**/api/**", async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        let body: unknown = {};
        if (pathname.endsWith("/environment")) body = { names: environmentNames };
        if (pathname.endsWith("/environment/NEW_KEY")) {
          environmentRequests.push(route.request().postDataJSON());
          environmentNames = ["PROJECT_ROOT", "NEW_KEY"];
          body = { names: environmentNames };
        }
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
      await expectBoldButtons(page);
      expect(
        await page
          .locator(".model-config-selector__model-label")
          .first()
          .evaluate((element) => getComputedStyle(element).fontWeight),
      ).toBe("700");
      expect(await workspace.evaluate((element) => getComputedStyle(element).fontWeight)).toBe(
        "400",
      );
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
      await expectBoldButtons(page);
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
      await page.getByRole("tab", { name: "Auth", exact: true }).click();
      await page.getByRole("button", { name: "Edit Gemini API key" }).click();
      const keyInput = page.getByPlaceholder("Paste Gemini API key");
      await keyInput.fill("Unsaved key draft");
      await page.getByRole("textbox", { name: "Variable name", exact: true }).fill("NEW_KEY");
      await page
        .getByRole("textbox", { name: "Variable value", exact: true })
        .fill("value with spaces");
      await page.getByRole("tab", { name: "Appearance" }).click();
      expect(await page.getByRole("textbox", { name: "App title" }).inputValue()).toBe(
        "Unsaved app title",
      );
      await page.getByRole("tab", { name: "Auth", exact: true }).click();
      expect(await keyInput.inputValue()).toBe("Unsaved key draft");
      expect(
        await page.getByRole("textbox", { name: "Variable name", exact: true }).inputValue(),
      ).toBe("NEW_KEY");
      const authFields = await page
        .locator("#settings-Auth-panel input:visible")
        .evaluateAll((elements) =>
          elements.map((element) => {
            const rect = element.getBoundingClientRect();
            return { left: rect.left, right: rect.right, height: rect.height };
          }),
        );
      for (const field of authFields) {
        expect(field.left).toBeCloseTo(controls[0]!.left, 0);
        expect(field.right).toBeLessThanOrEqual(width);
        expect(field.height).toBeGreaterThanOrEqual(44);
      }
      for (const button of await page.locator("#settings-Auth-panel button:visible").all()) {
        const bounds = await button.boundingBox();
        expect(bounds!.height).toBeGreaterThanOrEqual(44);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      }
      await expectBoldButtons(page);
      await page.screenshot({ path: `/tmp/settings-b-auth-${width}.png` });
      await page.getByRole("button", { name: "Set variable", exact: true }).click();
      await page.getByText("NEW_KEY", { exact: true }).waitFor();
      expect(environmentRequests).toEqual([{ value: "value with spaces" }]);
      expect(
        await page.getByRole("textbox", { name: "Variable name", exact: true }).inputValue(),
      ).toBe("");
      expect(
        await page.getByRole("textbox", { name: "Variable value", exact: true }).inputValue(),
      ).toBe("");
      await page.getByRole("button", { name: "Remove NEW_KEY" }).click();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(await page.getByText("NEW_KEY", { exact: true }).count()).toBe(1);
    } finally {
      await page.close();
    }
  });
}

for (const { width, label, sideBySide } of [
  { width: 1100, label: "Roy", sideBySide: true },
  { width: 390, label: "Roy", sideBySide: true },
  { width: 320, label: "Assistant workspace", sideBySide: false },
]) {
  test(`instruction buttons fit their labels at ${width}px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    try {
      await page.route("**/api/**", (route) => route.fulfill({ json: { names: [] } }));
      await page.goto(`${url}?assistantLabel=${encodeURIComponent(label)}`);
      const buttons = page.locator(".settings-popover__instruction-buttons button");
      await buttons.first().waitFor();
      const first = (await buttons.nth(0).boundingBox())!;
      const second = (await buttons.nth(1).boundingBox())!;
      if (sideBySide) {
        expect(second.y).toBeCloseTo(first.y, 0);
        expect(second.x).toBeGreaterThanOrEqual(first.x + first.width);
      } else {
        expect(second.y).toBeGreaterThanOrEqual(first.y + first.height);
        expect(second.x).toBeCloseTo(first.x, 0);
      }
      for (const bounds of [first, second]) {
        expect(bounds.height).toBeGreaterThanOrEqual(44);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      }
      await page.screenshot({ path: `/tmp/settings-instructions-${width}.png` });
    } finally {
      await page.close();
    }
  });
}
