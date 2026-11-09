// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fastify from "fastify";
import vue from "@vitejs/plugin-vue";
import { chromium, type Browser } from "patchright";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { createBrowserFixtureServer, closeBrowserFixtureServer } from "../test/browser-fixture";
import { registerWorkspaceFileRoutes } from "@/server/routes/workspace-files";
import { launchWebKit } from "../test/webkit";
import type { AppConfig } from "@/server/config";

let root: string;
let app: ReturnType<typeof fastify>;
let server: ViteDevServer;
let browser: Browser;
let url: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-code-ui-"));
  const project = path.join(root, "workspaces/project");
  await fs.mkdir(path.join(project, "src/empty"), { recursive: true });
  await fs.mkdir(path.join(root, "workspaces/other"));
  await fs.writeFile(path.join(root, "workspaces/other/other.txt"), "Other workspace");
  await fs.writeFile(path.join(project, "src/main.ts"), 'export const greeting = "Hej 🦾";\n');
  await fs.writeFile(path.join(project, ".hidden"), "Hidden content");
  await fs.writeFile(path.join(project, "empty"), "");
  await fs.writeFile(path.join(project, "binary"), Buffer.from([0, 1, 2]));
  app = fastify();
  registerWorkspaceFileRoutes(app, {
    battyDir: root,
    workspacesRoots: [path.join(root, "workspaces")],
  } as AppConfig);
  await app.ready();
  server = await createBrowserFixtureServer(
    "src/client/components/WorkspaceCodePopover.fixture.html",
    {
      plugins: [
        vue(),
        {
          name: "workspace-file-fixture",
          configureServer(vite) {
            vite.middlewares.use("/api", async (request, response) => {
              const result = await app.inject({ method: "GET", url: `/api${request.url}` });
              response.writeHead(result.statusCode, { "content-type": "application/json" });
              response.end(result.body);
            });
          },
        },
      ],
      define: { __BATTY_BUILD_ID__: JSON.stringify("dev") },
      resolve: { alias: { "@": path.resolve("src") } },
      server: { host: "127.0.0.1", port: 0 },
    },
  );
  await server.listen();
  url = `${server.resolvedUrls!.local[0]}src/client/components/WorkspaceCodePopover.fixture.html`;
  browser = await chromium.launch({ headless: true });
}, 30_000);
afterAll(async () => {
  await browser?.close();
  if (server) await closeBrowserFixtureServer(server);
  await app?.close();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

test("workspace row opens native code browser, lazily browses files and closes back to workspaces", async () => {
  for (const [width, colorScheme] of [
    [1280, "light"],
    [390, "dark"],
  ] as const) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme });
    page.setDefaultTimeout(5000);
    const calls: string[] = [];
    const errors: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/files?")) calls.push(request.url());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(url);
      await page.getByRole("button", { name: "Browse code in Project" }).click();
      const popover = page.locator("#tools-code");
      await popover.getByRole("treeitem", { name: "src", exact: true }).waitFor();
      expect(calls).toHaveLength(1);
      const bounds = await popover.boundingBox();
      expect(bounds!.width).toBeGreaterThan(width - 50);
      expect(bounds!.height).toBeGreaterThan(820);
      await popover.getByRole("treeitem", { name: "src", exact: true }).click();
      await popover.getByRole("treeitem", { name: "main.ts", exact: true }).waitFor();
      expect(calls).toHaveLength(2);
      await popover.getByRole("treeitem", { name: "main.ts", exact: true }).click();
      await popover
        .locator("[data-line]")
        .filter({ hasText: 'export const greeting = "Hej 🦾";' })
        .waitFor();
      await expect
        .poll(() => popover.locator("[data-line] span").count(), { timeout: 10_000 })
        .toBeGreaterThan(1);
      expect(await popover.getByRole("region", { name: "File preview" }).isVisible()).toBe(true);
      expect(await popover.locator("textarea, [contenteditable=true]").count()).toBe(0);
      if (process.env.BATTY_UI_SCREENSHOTS === "1") {
        await fs.mkdir(".tmp/ui-feedback", { recursive: true });
        await page.screenshot({ path: `.tmp/ui-feedback/code-source-${width}-${colorScheme}.png` });
      }
      if (width < 600) await popover.getByRole("button", { name: "Files", exact: true }).click();
      await popover.getByRole("treeitem", { name: "binary", exact: true }).click();
      await popover.getByText("Binary file — no text preview.").waitFor();
      if (width < 600) await popover.getByRole("button", { name: "Files", exact: true }).click();
      await popover.locator('[role="treeitem"][data-item-path="empty"]').click();
      await popover.getByText("Empty file.", { exact: true }).waitFor();
      if (width < 600) await popover.getByRole("button", { name: "Files", exact: true }).click();
      await popover.getByRole("treeitem", { name: ".hidden", exact: true }).click();
      await popover.locator("[data-line]").filter({ hasText: "Hidden content" }).waitFor();
      if (process.env.BATTY_UI_SCREENSHOTS === "1") {
        await fs.mkdir(".tmp/ui-feedback", { recursive: true });
        await page.screenshot({ path: `.tmp/ui-feedback/code-${width}-${colorScheme}.png` });
      }
      await page.keyboard.press("Escape");
      expect(await popover.isVisible()).toBe(false);
      await page.getByRole("button", { name: "Browse code in Other" }).click();
      await popover.getByRole("treeitem", { name: "other.txt", exact: true }).click();
      await popover.locator("[data-line]").filter({ hasText: "Other workspace" }).waitFor();
      expect(await popover.getByRole("treeitem", { name: "src", exact: true }).count()).toBe(0);
      await popover.getByRole("button", { name: "Close code browser" }).click();
      expect(await page.getByRole("button", { name: "Browse code in Project" }).isVisible()).toBe(
        true,
      );
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }
});

test("directory failures are visible and retryable, file failures do not leave stale source", async () => {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  let fail = true;
  try {
    await page.route("**/api/workspaces/project/files?path=src", (route) =>
      fail
        ? route.fulfill({ status: 500, json: { error: "Directory unavailable" } })
        : route.continue(),
    );
    await page.goto(url);
    await page.getByRole("button", { name: "Browse code in Project" }).click();
    const popover = page.locator("#tools-code");
    await popover.getByRole("treeitem", { name: "src", exact: true }).click();
    await popover.getByRole("alert").filter({ hasText: "Directory unavailable" }).waitFor();
    fail = false;
    await popover.getByRole("button", { name: "Retry", exact: true }).click();
    await popover.getByRole("treeitem", { name: "main.ts", exact: true }).click();
    await popover.locator("[data-line]").filter({ hasText: "export const greeting" }).waitFor();
    await page.route("**/api/workspaces/project/files?path=.hidden", (route) =>
      route.fulfill({ status: 403, json: { error: "Path leaves the workspace" } }),
    );
    await popover.getByRole("treeitem", { name: ".hidden", exact: true }).click();
    await popover.getByRole("alert").filter({ hasText: "Path leaves the workspace" }).waitFor();
    expect(await popover.locator("[data-line]").count()).toBe(0);
  } finally {
    await page.close();
  }
});

test("WebKit: mobile code browser supports keyboard folder navigation and source preview", async () => {
  const safari = await launchWebKit();
  const page = await safari.newPage({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });
  page.setDefaultTimeout(5000);
  try {
    await page.goto(url);
    await page.getByRole("button", { name: "Browse code in Project" }).click();
    const popover = page.getByRole("dialog", { name: "Code in Project" });
    const folder = popover.getByRole("treeitem", { name: "src", exact: true });
    await folder.focus();
    await page.keyboard.press("ArrowRight");
    const file = popover.getByRole("treeitem", { name: "main.ts", exact: true });
    await file.focus();
    await page.keyboard.press("Enter");
    await popover.locator("[data-line]").filter({ hasText: "export const greeting" }).waitFor();
    await expect
      .poll(() => popover.locator("[data-line] span").count(), { timeout: 10_000 })
      .toBeGreaterThan(1);
    await popover.getByRole("button", { name: "Files", exact: true }).click();
    expect(await file.isVisible()).toBe(true);
    await popover.getByRole("button", { name: "Close code browser" }).click();
    expect(await page.getByRole("button", { name: "Browse code in Project" }).isVisible()).toBe(
      true,
    );
  } finally {
    await page.close();
    await safari.close();
  }
});
