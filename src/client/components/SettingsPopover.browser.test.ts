// @vitest-environment node
import path from "node:path";
import fs from "node:fs/promises";
import { APP_COLOR_OPTIONS } from "@/shared/appearance";
import vue from "@vitejs/plugin-vue";
import { chromium, type Browser } from "patchright";
import type { ViteDevServer } from "vite";
import { closeBrowserFixtureServer, createBrowserFixtureServer } from "../test/browser-fixture";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

let server: ViteDevServer;
let browser: Browser;
let url: string;
const captureScreenshots = process.env.BATTY_UI_SCREENSHOTS === "1";
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

test("popover chrome remains keyboard-accessible and fits narrow screens in both themes", async () => {
  for (const colorScheme of ["light", "dark"] as const) {
    for (const width of [320, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme });
      try {
        await page.route("**/api/**", (route) => route.fulfill({ json: { names: [] } }));
        await page.goto(url);
        const tabs = page.getByRole("tablist", { name: "Settings", exact: true });
        const first = tabs.getByRole("tab", { name: "Assistant", exact: true });
        await first.focus();
        await page.keyboard.press("ArrowRight");
        await expect
          .poll(() =>
            page
              .getByRole("tab", { name: "Appearance", exact: true })
              .getAttribute("aria-selected"),
          )
          .toBe("true");
        expect(await page.evaluate(() => document.activeElement?.getAttribute("role"))).toBe("tab");
        const header = page.locator("#settings .full-popover__header");
        expect(await header.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
          true,
        );
        if (captureScreenshots) await fs.mkdir(".tmp/ui-feedback", { recursive: true });
        let buttonColor: string | undefined;
        for (const option of APP_COLOR_OPTIONS) {
          await page.evaluate(`(async () => {
            const { applyAppAppearance } = await import("/src/client/lib/appearance.ts");
            applyAppAppearance({ title: "Batty", color: ${JSON.stringify(option.id)} });
          })()`);
          const chrome = await header.evaluate((element) => {
            const style = getComputedStyle(element);
            const tab = document.querySelector('[role="tab"][aria-selected="true"]')!;
            const tabStyle = getComputedStyle(tab);
            return {
              background: style.backgroundColor,
              shadow: style.boxShadow,
              underline: tabStyle.borderBottomStyle,
              underlineWidth: parseFloat(tabStyle.borderBottomWidth),
              buttonColor: getComputedStyle(document.querySelector(".full-popover__close")!).color,
            };
          });
          expect(chrome.background).toBe(
            colorScheme === "light" ? "rgb(255, 255, 255)" : "rgb(23, 33, 40)",
          );
          expect(chrome.shadow).not.toBe("none");
          expect(chrome.underline).toBe("solid");
          expect(chrome.underlineWidth).toBeGreaterThanOrEqual(2);
          buttonColor ??= chrome.buttonColor;
          expect(chrome.buttonColor).toBe(buttonColor);
          if (captureScreenshots)
            await page.screenshot({
              path: `.tmp/ui-feedback/settings-${option.id}-${colorScheme}-${width}.png`,
            });
        }
        const close = page.getByRole("button", { name: "Close settings", exact: true });
        const bounds = (await close.boundingBox())!;
        expect(bounds.width).toBeGreaterThanOrEqual(44);
        expect(bounds.height).toBeGreaterThanOrEqual(44);
        await close.focus();
        expect(
          await close.evaluate((element) => {
            const style = getComputedStyle(element);
            return (
              element.matches(":focus-visible") &&
              style.outlineStyle !== "none" &&
              parseFloat(style.outlineWidth) >= 2
            );
          }),
        ).toBe(true);
        await page.keyboard.press("Enter");
        await expect
          .poll(() =>
            page.locator("#settings").evaluate((element) => element.matches(":popover-open")),
          )
          .toBe(false);
      } finally {
        await page.close();
      }
    }
  }
});

test("popover tabs meet the body edge and stay on one navigable row on narrow screens", async () => {
  for (const view of ["cron", "settings", "tools"]) {
    for (const width of [320, 1280]) {
      for (const colorScheme of ["light", "dark"] as const) {
        const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme });
        try {
          await page.route("**/api/**", (route) =>
            route.fulfill({ json: { names: [], servers: [] } }),
          );
          await page.goto(`${url}?view=${view}`);
          const popover = page.locator(`#${view}`);
          const tablist = popover.getByRole("tablist");
          const tabs = tablist.getByRole("tab");
          await tabs.first().focus();
          await page.keyboard.press("End");
          const last = tabs.last();
          await expect.poll(() => last.getAttribute("aria-selected")).toBe("true");
          expect(await last.evaluate((element) => element === document.activeElement)).toBe(true);
          const layout = await popover.evaluate((element) => {
            const header = element.querySelector(".full-popover__header")!;
            const list = element.querySelector('[role="tablist"]')!;
            const rect = list.getBoundingClientRect();
            const buttons = [...list.querySelectorAll('[role="tab"]')];
            const active = buttons.find(
              (button) => button.getAttribute("aria-selected") === "true",
            )!;
            const selected = active.getBoundingClientRect();
            return {
              gap:
                element.querySelector(".full-popover__body")!.getBoundingClientRect().top -
                rect.bottom,
              rows: buttons.map((button) => button.getBoundingClientRect().top),
              fits: header.scrollWidth <= header.clientWidth,
              selectedVisible: selected.left >= rect.left && selected.right <= rect.right + 1,
            };
          });
          expect(layout.gap).toBeLessThanOrEqual(1);
          expect(new Set(layout.rows).size).toBe(1);
          expect(layout.fits).toBe(true);
          expect(layout.selectedVisible).toBe(true);
        } finally {
          await page.close();
        }
      }
    }
  }
});

test("instance colors affect app header and footer, not controls or content", async () => {
  if (captureScreenshots) await fs.mkdir(".tmp/ui-feedback", { recursive: true });
  for (const colorScheme of ["light", "dark"] as const) {
    for (const width of [320, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme });
      try {
        await page.route("**/api/**", (route) => route.fulfill({ json: { names: [] } }));
        await page.goto(`${url}?shell=1`);
        let controls: unknown;
        for (const option of APP_COLOR_OPTIONS) {
          await page.evaluate(`(async () => {
            const { applyAppAppearance } = await import("/src/client/lib/appearance.ts");
            applyAppAppearance({ title: "Batty", color: ${JSON.stringify(option.id)} });
          })()`);
          const actual = await page.evaluate(() => {
            const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
            const button = style('.header [aria-label="Cron"]');
            const input = style(".composer__input");
            return {
              header: style(".header").backgroundColor,
              footer: style(".composer").backgroundColor,
              shadow: style(".header").boxShadow,
              controls: [
                button.color,
                button.backgroundColor,
                input.color,
                input.backgroundColor,
                style(".app-shell").backgroundColor,
              ],
            };
          });
          const hex = colorScheme === "light" ? option.light : option.dark;
          const rgb = hex
            .slice(1)
            .match(/../g)!
            .map((part) => parseInt(part, 16));
          expect(actual.header).toBe(`rgb(${rgb.join(", ")})`);
          expect(actual.footer).toBe(actual.header);
          expect(actual.shadow).not.toBe("none");
          controls ??= actual.controls;
          expect(actual.controls).toEqual(controls);
          if (captureScreenshots)
            await page.screenshot({
              path: `.tmp/ui-feedback/shell-${option.id}-${colorScheme}-${width}.png`,
            });
        }
      } finally {
        await page.close();
      }
    }
  }
});

test("Remote settings provisions connections and grants on mobile without retaining tokens", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  const requests: Record<string, string>[] = [];
  let grants: { id: string; label: string }[] = [];
  let connections: { id: string; label: string; url: string }[] = [];
  try {
    await page.route("**/api/remotes", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ json: { instanceId: "local", grants, connections } });
        return;
      }
      const input = route.request().postDataJSON();
      requests.push(input);
      let body: unknown = { ok: true };
      switch (input.action) {
        case "grant-add":
          grants = [{ id: "grant", label: input.label }];
          body = { id: "grant", token: "issued-private-token" };
          break;
        case "grant-revoke":
          grants = [];
          break;
        case "connection-add":
          connections = [{ id: input.id, label: input.label, url: input.url }];
          break;
        case "connection-remove":
          connections = [];
          break;
      }
      await route.fulfill({ json: body });
    });
    await page.route("**/api/settings/environment", (route) =>
      route.fulfill({ json: { names: [] } }),
    );
    await page.goto(url);
    await page.getByRole("tab", { name: "Remote", exact: true }).click();
    await page.getByText("No connections.", { exact: true }).waitFor();
    await page.getByRole("textbox", { name: "Grant name", exact: true }).fill("Office");
    await page.getByRole("button", { name: "Create token", exact: true }).click();
    await expect
      .poll(() => page.getByRole("textbox", { name: "New token", exact: true }).inputValue())
      .toBe("issued-private-token");
    await page.getByRole("tab", { name: "Auth", exact: true }).click();
    await page.getByRole("tab", { name: "Remote", exact: true }).click();
    expect(await page.getByRole("textbox", { name: "New token", exact: true }).count()).toBe(0);
    await page.getByRole("textbox", { name: "Connection name", exact: true }).fill("Work");
    await page
      .getByRole("textbox", { name: "Remote URL", exact: true })
      .fill("https://work.example.com/batty/");
    await page.getByLabel("Remote token", { exact: true }).fill("outgoing-private-token");
    await page.getByRole("button", { name: "Add connection", exact: true }).click();
    await page.getByRole("button", { name: "Remove connection Work", exact: true }).waitFor();
    expect(await page.getByLabel("Remote token", { exact: true }).inputValue()).toBe("");
    await page.getByRole("button", { name: "Remove connection Work", exact: true }).click();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(requests.some((request) => request.action === "connection-remove")).toBe(false);
    await page.getByRole("button", { name: "Remove connection Work", exact: true }).click();
    await page
      .getByRole("button", { name: "Confirm: Remove connection Work", exact: true })
      .click();
    await page.getByText("No connections.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Revoke access Office", exact: true }).click();
    await page.getByRole("button", { name: "Confirm: Revoke access Office", exact: true }).click();
    await page.getByText("No incoming access.", { exact: true }).waitFor();
    expect(requests).toEqual([
      { action: "grant-add", label: "Office" },
      {
        action: "connection-add",
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        label: "Work",
        url: "https://work.example.com/batty/",
        token: "outgoing-private-token",
      },
      { action: "connection-remove", id: requests[1]!.id },
      { action: "grant-revoke", id: "grant" },
    ]);
    expect(
      await page
        .locator("#settings-Remote-panel")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain("private-token");
  } finally {
    await page.close();
  }
});

for (const width of [390]) {
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
      await page.getByRole("combobox", { name: "Assistant workspace", exact: true }).waitFor();
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
