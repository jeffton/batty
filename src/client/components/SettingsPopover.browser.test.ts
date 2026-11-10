import { fixtureOperation } from "../test/socket-fixture";
import { RpcError } from "../../shared/rpc-channel";
// @vitest-environment node
import path from "node:path";
import fs from "node:fs/promises";
import vue from "@vitejs/plugin-vue";
import { chromium, type Browser } from "patchright";
import type { ViteDevServer } from "vite";
import { closeBrowserFixtureServer, createBrowserFixtureServer } from "../test/browser-fixture";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { launchWebKit } from "../test/webkit";

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

test("instance colors affect app header and footer, not controls or content", async () => {
  if (captureScreenshots) await fs.mkdir(".tmp/ui-feedback", { recursive: true });
  for (const [colorScheme, width] of [
    ["dark", 320],
    ["light", 1280],
  ] as const) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme });
    try {
      await fixtureOperation(server, page, "environment.list", async () => ({
        value: { names: [] },
      }));
      await page.goto(`${url}?shell=1`);
      let controls: unknown;
      let previousHeader: string | undefined;
      for (const color of ["neutral", "blue"]) {
        await page.evaluate(`(async () => {
            const { applyAppAppearance } = await import("/src/client/lib/appearance.ts");
            applyAppAppearance({ title: "Batty", color: ${JSON.stringify(color)} });
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
        expect(actual.header).not.toBe("rgba(0, 0, 0, 0)");
        if (previousHeader) expect(actual.header).not.toBe(previousHeader);
        previousHeader = actual.header;
        expect(actual.footer).toBe(actual.header);
        expect(actual.shadow).not.toBe("none");
        controls ??= actual.controls;
        expect(actual.controls).toEqual(controls);
        if (captureScreenshots)
          await page.screenshot({
            path: `.tmp/ui-feedback/shell-${color}-${colorScheme}-${width}.png`,
          });
      }
    } finally {
      await page.close();
    }
  }
});

for (const engine of ["chromium", "webkit"] as const) {
  test(`Remote settings generates tokens and adds peers with URL and token in ${engine}`, async () => {
    const instance = (engine === "webkit" ? await launchWebKit() : browser) as unknown as Browser;
    const page = await instance.newPage({ viewport: { width: 390, height: 900 } });
    const requests: Record<string, string>[] = [];
    let grants: { id: string; label: string }[] = [];
    let connections: Record<string, unknown>[] = [];
    try {
      await fixtureOperation(server, page, "remotes.get", async () => ({
        value: { instanceId: "local", grants, connections },
      }));
      await fixtureOperation(
        server,
        page,
        [
          "remotes.token.generate",
          "remotes.token.revoke",
          "remotes.connection.add",
          "remotes.connection.remove",
        ],
        async (payload, _context, _next, operation) => {
          const input = payload as Record<string, string>;
          requests.push({ operation, ...input });
          let body: unknown = { ok: true };
          switch (operation) {
            case "remotes.token.generate":
              grants = [{ id: "invitation", label: "Unused token" }];
              body = { id: "invitation", token: "issued-private-token" };
              break;
            case "remotes.token.revoke":
              grants = [];
              break;
            case "remotes.connection.add":
              connections = [
                {
                  id: "automatic-work-id",
                  label: "Work",
                  url: input.url,
                  status: { state: "connected" },
                },
              ];
              break;
            case "remotes.connection.remove":
              connections = [];
              break;
          }
          return { value: body };
        },
      );
      await fixtureOperation(server, page, "environment.list", async () => ({
        value: { names: [] },
      }));
      await page.goto(url);
      await page.getByRole("tab", { name: "Remote", exact: true }).click();
      await page.getByText("No connections.", { exact: true }).waitFor();
      const panel = page.locator("#settings-Remote-panel");
      expect(await panel.locator("input").count()).toBe(2);
      expect(await panel.locator('input[type="password"]').count()).toBe(0);
      expect(await page.getByLabel("Remote URL", { exact: true }).getAttribute("name")).toBe(
        "pairing-url",
      );
      expect(await page.getByLabel("Remote token", { exact: true }).getAttribute("name")).toBe(
        "pairing-token",
      );
      expect(
        await page.getByLabel("Remote token", { exact: true }).getAttribute("autocomplete"),
      ).toBe("one-time-code");
      expect(await panel.getByRole("combobox").count()).toBe(0);
      expect(await panel.getByRole("checkbox").count()).toBe(0);
      await page.getByRole("button", { name: "Generate token", exact: true }).click();
      await expect
        .poll(
          () => page.getByRole("textbox", { name: "Generated token", exact: true }).inputValue(),
          { timeout: 5_000 },
        )
        .toBe("issued-private-token");
      await page.getByLabel("Remote token", { exact: true }).fill("draft-private-token");
      await page.getByRole("tab", { name: "Auth", exact: true }).click();
      await page.getByRole("tab", { name: "Remote", exact: true }).click();
      expect(
        await page.getByRole("textbox", { name: "Generated token", exact: true }).count(),
      ).toBe(0);
      expect(await page.getByLabel("Remote token", { exact: true }).inputValue()).toBe("");
      await page
        .getByRole("textbox", { name: "Remote URL", exact: true })
        .fill("https://work.example.com/batty/");
      await page.getByLabel("Remote token", { exact: true }).fill("outgoing-private-token");
      await page.getByLabel("Remote token", { exact: true }).press("Enter");
      await page.getByRole("button", { name: "Remove connection Work", exact: true }).waitFor();
      await page.getByText("Online", { exact: true }).waitFor();
      expect(await page.getByLabel("Remote token", { exact: true }).inputValue()).toBe("");
      await page.getByRole("button", { name: "Remove connection Work", exact: true }).click();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(requests.some((request) => request.operation === "remotes.connection.remove")).toBe(
        false,
      );
      await page.getByRole("button", { name: "Remove connection Work", exact: true }).click();
      await page
        .getByRole("button", { name: "Confirm: Remove connection Work", exact: true })
        .click();
      await page.getByText("No connections.", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Cancel unused token", exact: true }).click();
      await page.getByRole("button", { name: "Confirm: Cancel unused token", exact: true }).click();
      await expect.poll(() => page.getByText("Unused token", { exact: true }).count()).toBe(0);
      expect(requests).toEqual([
        { operation: "remotes.token.generate" },
        {
          operation: "remotes.connection.add",
          url: "https://work.example.com/batty/",
          token: "outgoing-private-token",
        },
        { operation: "remotes.connection.remove", id: "automatic-work-id" },
        { operation: "remotes.token.revoke", id: "invitation" },
      ]);
      expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
        "private-token",
      );
    } finally {
      await page.close();
      if (engine === "webkit") await instance.close();
    }
  });
}

for (const engine of ["chromium", "webkit"] as const) {
  test(`Remote settings copies its own URL separately from the token in ${engine}`, async () => {
    const instance = (engine === "webkit" ? await launchWebKit() : browser) as unknown as Browser;
    try {
      for (const [width, colorScheme] of [
        [320, "dark"],
        [390, "dark"],
        [430, "light"],
        [1280, "light"],
      ] as const) {
        const context = await instance.newContext({
          colorScheme,
          ...(engine === "chromium"
            ? { permissions: ["clipboard-read", "clipboard-write", "local-network-access"] }
            : {}),
        });
        const page = await context.newPage();
        page.setDefaultTimeout(5_000);
        await page.setViewportSize({ width, height: 900 });
        const base = "/nested/very-long%20workspace-name/department/project/batty/";
        const token = "fixture-only-invitation-".repeat(8);
        try {
          await page.addInitScript((base) => {
            window.__BATTY_BASE_URL__ = base;
          }, base);
          await fixtureOperation(server, page, "environment.list", async () => ({
            value: { names: [] },
          }));
          await fixtureOperation(server, page, "remotes.get", async () => ({
            value: { grants: [], connections: [] },
          }));
          await fixtureOperation(server, page, "remotes.token.generate", async () => ({
            value: { id: "fixture", token },
          }));
          await page.goto(`${url}?route=not-part-of-address#fragment`);
          await page.getByRole("tab", { name: "Remote", exact: true }).click();
          const panel = page.getByRole("region", { name: "Remote Batty", exact: true });
          const expected = new URL(url).origin + base.slice(0, -1);
          for (const heading of ["This Batty", "Connect to another Batty", "Connections"]) {
            expect(await panel.getByRole("heading", { name: heading, exact: true }).count()).toBe(
              1,
            );
          }
          if (captureScreenshots) {
            await fs.mkdir(".tmp/ui-feedback", { recursive: true });
            await page.screenshot({
              path: `.tmp/ui-feedback/remote-layout-empty-${engine}-${width}.png`,
            });
          }
          expect(await panel.locator("code").innerText()).toBe(expected);
          expect(await panel.getByRole("button", { name: "Copy token", exact: true }).count()).toBe(
            0,
          );
          await panel.getByRole("button", { name: "Copy URL", exact: true }).click();
          await expect
            .poll(() =>
              panel.getByRole("button", { name: "Copy URL", exact: true }).getAttribute("title"),
            )
            .toBe("Copied");
          if (engine === "chromium")
            expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(expected);
          await panel.getByRole("button", { name: "Generate token", exact: true }).click();
          await panel.getByRole("button", { name: "Copy token", exact: true }).click();
          await expect
            .poll(() =>
              panel.getByRole("button", { name: "Copy token", exact: true }).getAttribute("title"),
            )
            .toBe("Copied");
          if (engine === "chromium")
            expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(token);
          expect(
            await panel
              .getByRole("button", { name: "Copy URL", exact: true })
              .getAttribute("title"),
          ).toBe("Copied");
          expect(await panel.locator("input").count()).toBe(2);
          expect(await panel.getByRole("alert").count()).toBe(0);
          expect(
            await panel.evaluate((element) => element.scrollWidth <= element.clientWidth),
          ).toBe(true);
          expect(
            await panel.locator("code").evaluate((element) => {
              const box = element.getBoundingClientRect();
              return box.left >= 0 && box.right <= innerWidth;
            }),
          ).toBe(true);
          if (captureScreenshots) {
            await fs.mkdir(".tmp/ui-feedback", { recursive: true });
            await page.screenshot({
              path: `.tmp/ui-feedback/remote-layout-generated-${engine}-${width}.png`,
            });
          }
        } finally {
          await context.close();
        }
      }
    } finally {
      if (engine === "webkit") await instance.close();
    }
  });
}

test("Remote settings shows automatic peer names, offline status and pairing errors", async () => {
  for (const width of [390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const requests: Record<string, unknown>[] = [];
    let connected = false;
    try {
      await fixtureOperation(server, page, "remotes.get", async () => ({
        value: {
          instanceId: "hidden-installation-id",
          grants: [],
          connections: connected
            ? [
                {
                  id: "automatic-peer-id",
                  label: "Work PC",
                  url: "https://work.example.com/batty/",
                  status: { state: "connected" },
                },
                {
                  id: "automatic-offline-id",
                  label: "Home Mac",
                  url: "",
                  status: { state: "disconnected" },
                },
              ]
            : [],
        },
      }));
      await fixtureOperation(server, page, "remotes.connection.add", async (payload) => {
        const input = payload as Record<string, unknown>;
        requests.push(input);
        if (requests.length === 1) throw new RpcError("BAD_INPUT", "Token already used");
        connected = true;
        return { value: { ok: true } };
      });
      await fixtureOperation(server, page, "environment.list", async () => ({
        value: { names: [] },
      }));
      await page.goto(url);
      await page.getByRole("tab", { name: "Remote", exact: true }).click();
      await page.getByText("No connections.", { exact: true }).waitFor();
      const panel = page.locator("#settings-Remote-panel");
      expect(await panel.locator("input").count()).toBe(2);
      expect(await panel.getByRole("combobox").count()).toBe(0);
      expect(await panel.getByRole("checkbox").count()).toBe(0);
      await page
        .getByRole("textbox", { name: "Remote URL", exact: true })
        .fill("https://work.example.com/batty/");
      await page.getByLabel("Remote token", { exact: true }).fill("private-work-token");
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await page.getByRole("alert").getByText("Token already used", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await page.getByText("Online", { exact: true }).waitFor();
      await page.getByText("Offline", { exact: true }).waitFor();
      expect(
        await page.getByRole("button", { name: "Remove connection Work PC", exact: true }).count(),
      ).toBe(1);
      expect(
        await page.getByRole("button", { name: "Remove connection Home Mac", exact: true }).count(),
      ).toBe(1);
      expect(requests).toEqual([
        {
          url: "https://work.example.com/batty/",
          token: "private-work-token",
        },
        {
          url: "https://work.example.com/batty/",
          token: "private-work-token",
        },
      ]);
      expect(await page.getByLabel("Remote token", { exact: true }).inputValue()).toBe("");
      await page.reload();
      await page.getByRole("tab", { name: "Remote", exact: true }).click();
      await page.getByText("Online", { exact: true }).waitFor();
      expect(await page.getByLabel("Remote URL", { exact: true }).inputValue()).toBe("");
      expect(await page.getByLabel("Remote token", { exact: true }).inputValue()).toBe("");
      expect(await panel.innerText()).not.toContain("hidden-installation-id");
      expect(await panel.innerText()).not.toContain("automatic-peer-id");
      expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
        "private-work-token",
      );
      if (captureScreenshots) {
        await fs.mkdir(".tmp/ui-feedback", { recursive: true });
        await page
          .getByRole("button", { name: "Generate token", exact: true })
          .scrollIntoViewIfNeeded();
        await page.screenshot({ path: `.tmp/ui-feedback/remote-pairing-${width}.png` });
      }
    } finally {
      await page.close();
    }
  }
});

for (const width of [390]) {
  test(`settings controls, drafts and nested editors at ${width}px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const appearanceRequests: unknown[] = [];
    const environmentRequests: unknown[] = [];
    let environmentNames = ["PROJECT_ROOT"];
    try {
      await fixtureOperation(server, page, "environment.list", async () => ({
        value: { names: environmentNames },
      }));
      await fixtureOperation(server, page, "environment.set", async (input) => {
        environmentRequests.push(input);
        environmentNames = ["PROJECT_ROOT", "NEW_KEY"];
        return { value: { names: environmentNames } };
      });
      await fixtureOperation(server, page, "settings.appearance", async (appearance) => {
        appearanceRequests.push(appearance);
        return { value: { appearance } };
      });
      await fixtureOperation(server, page, "assistant-agents.get", async () => ({
        value: { content: "Workspace instructions" },
      }));
      await fixtureOperation(server, page, "memory.tree", async () => ({
        value: { nodes: [], prepared: 0, total: 0 },
      }));
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
      expect(environmentRequests).toEqual([{ name: "NEW_KEY", value: "value with spaces" }]);
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

test("copies saved keys and environment values through the real clipboard without rendering them", async () => {
  const context = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write", "local-network-access"],
  });
  try {
    for (const width of [320, 1280]) {
      const page = await context.newPage();
      await page.setViewportSize({ width, height: 900 });
      let copies = 0;
      await fixtureOperation(server, page, "settings.copy-value", async () => {
        copies++;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { value: { value: "fixture-copy-value" } };
      });
      await fixtureOperation(server, page, "environment.list", async () => ({
        value: { names: ["NORMAL_VALUE"] },
      }));
      await page.goto(`${url}?savedKeys`);
      await page.getByRole("tab", { name: "Auth", exact: true }).click();
      expect(copies).toBe(0);
      for (const label of ["Gemini API key", "Brave Search API key"]) {
        await page.getByRole("button", { name: `Edit ${label}`, exact: true }).click();
        expect(await page.getByRole("button", { name: `Copy ${label}`, exact: true }).count()).toBe(
          0,
        );
        await page.getByRole("button", { name: `Close ${label}`, exact: true }).click();
        await page.getByRole("button", { name: `Copy ${label}`, exact: true }).waitFor();
      }
      for (const label of ["Gemini API key", "Brave Search API key", "NORMAL_VALUE"]) {
        const copy = page.getByRole("button", { name: `Copy ${label}`, exact: true });
        await copy.click();
        const confirmed = page.getByRole("button", { name: `Copied ${label}`, exact: true });
        await confirmed.waitFor();
        expect(await confirmed.innerText()).toBe("");
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
          "fixture-copy-value",
        );
        expect(await page.locator("body").innerText()).not.toContain("fixture-copy-value");
        expect(
          await confirmed.evaluate((element) => {
            const box = element.getBoundingClientRect();
            return box.left >= 0 && box.right <= innerWidth;
          }),
        ).toBe(true);
      }
      await page.getByRole("button", { name: "Copy NORMAL_VALUE", exact: true }).waitFor();
      expect(copies).toBe(3);
      await page.close();
    }
  } finally {
    await context.close();
  }
});
