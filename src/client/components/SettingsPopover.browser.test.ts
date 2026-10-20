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
    expect(await page.getByRole("textbox", { name: "Connection ID", exact: true }).count()).toBe(0);
    expect(await page.locator("#settings-Remote-panel [placeholder]").count()).toBe(0);
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
