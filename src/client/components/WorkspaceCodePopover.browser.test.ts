import { fixtureOperation, setFixtureRpcHandler } from "../test/socket-fixture";
import { createOwnerRpcHandler, type OwnerRpcServices } from "@/server/owner-rpc";
import type { Runtime } from "@/server/runtime";
import { RpcError } from "@/shared/rpc-channel";
// @vitest-environment node
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import vue from "@vitejs/plugin-vue";
import { chromium, type Browser } from "patchright";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { createBrowserFixtureServer, closeBrowserFixtureServer } from "../test/browser-fixture";
import { launchWebKit } from "../test/webkit";
import type { AppConfig } from "@/server/config";

let root: string;
let server: ViteDevServer;
let browser: Browser;
let url: string;
let incrementalSearch: ReadableStreamDefaultController<unknown> | undefined;
const wrappedSource = [
  `export const sentence = "${"Text with spaces and indentation. ".repeat(15)}";`,
  `  const unbroken = "${"a".repeat(420)}";`,
  "  console.log(sentence, unbroken);",
].join("\n");
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-code-ui-"));
  const project = path.join(root, "workspaces/project");
  await fs.mkdir(path.join(project, "src/empty"), { recursive: true });
  await fs.mkdir(path.join(root, "workspaces/other"));
  await fs.writeFile(path.join(root, "workspaces/other/other.txt"), "Other workspace");
  await fs.writeFile(path.join(project, "src/main.ts"), 'export const greeting = "Hej 🦾";\n');
  await fs.writeFile(path.join(project, "src/long.ts"), wrappedSource);
  for (const folder of ["unopened/deeper", "another", "QuickNeedle-directory", ".git/objects"])
    await fs.mkdir(path.join(project, folder), { recursive: true });
  await fs.writeFile(
    path.join(project, "unopened/deeper/QuickNeedle.ts"),
    'export const found = "unopened";',
  );
  await fs.writeFile(
    path.join(project, "another/QuickNeedle.ts"),
    'export const found = "another";',
  );
  await fs.writeFile(path.join(project, "QuickNeedle-directory/nohit.txt"), "not a filename match");
  await fs.writeFile(
    path.join(project, ".git/objects/HiddenNeedle.ts"),
    'export const found = "hidden";',
  );
  await fs.writeFile(path.join(project, ".hidden"), "Hidden content");
  await fs.writeFile(path.join(project, "empty"), "");
  await fs.writeFile(path.join(project, "binary"), Buffer.from([0, 1, 2]));
  await promisify(execFile)("git", [
    "-C",
    project,
    "init",
    "--initial-branch=feature/current-branch",
  ]);
  const config = { battyDir: root, workspacesRoots: [path.join(root, "workspaces")] } as AppConfig;
  const handle = createOwnerRpcHandler(
    { config, tools: {} } as unknown as Runtime,
    {} as OwnerRpcServices,
  );
  server = await createBrowserFixtureServer(
    "src/client/components/WorkspaceCodePopover.fixture.html",
    {
      plugins: [vue()],
      define: { __BATTY_BUILD_ID__: JSON.stringify("dev") },
      resolve: { alias: { "@": path.resolve("src") } },
      server: { host: "127.0.0.1", port: 0 },
    },
  );
  setFixtureRpcHandler(server, async (operation, input, context) => {
    if (operation === "workspace.search" && (input as { name: string }).name === "needle-stream") {
      return {
        value: null,
        events: new ReadableStream<unknown>({
          start(controller) {
            incrementalSearch = controller;
            controller.enqueue({ kind: "match", path: "one/needle-stream.ts" });
          },
          cancel() {
            incrementalSearch = undefined;
          },
        }),
      };
    }
    return handle(operation, input, context);
  });
  await server.listen();
  url = `${server.resolvedUrls!.local[0]}src/client/components/WorkspaceCodePopover.fixture.html`;
  browser = await chromium.launch({ headless: true });
}, 30_000);
afterAll(async () => {
  await browser?.close();
  if (server) await closeBrowserFixtureServer(server);
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
    await fixtureOperation(server, page, "workspace.files", async (input, _context, next) => {
      calls.push(input.path ?? "");
      return next();
    });
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(url);
      await page
        .locator(".tools-popover__branch")
        .getByText("feature/current-branch", { exact: true })
        .waitFor();
      await page.getByRole("button", { name: "Browse code in Project" }).click();
      const popover = page.locator("#tools-code");
      await popover
        .locator(".workspace-code__branch")
        .getByText("feature/current-branch", { exact: true })
        .waitFor();
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

test("refreshes actual branches on reopening, with long names contained on mobile", async () => {
  const branch = `feature/${"long-branch-name-".repeat(7)}`;
  const project = path.join(root, "workspaces/project");
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  const setBranch = (name: string) =>
    promisify(execFile)("git", ["-C", project, "symbolic-ref", "HEAD", `refs/heads/${name}`]);
  try {
    await page.goto(url);
    await page
      .locator(".tools-popover__branch")
      .getByText("feature/current-branch", { exact: true })
      .waitFor();
    await page.getByRole("button", { name: "Browse code in Project" }).click();
    const popover = page.locator("#tools-code");
    await popover
      .locator(".workspace-code__branch")
      .getByText("feature/current-branch", { exact: true })
      .waitFor();
    await popover.getByRole("button", { name: "Close code browser" }).click();
    await setBranch(branch);
    await page.getByRole("button", { name: "Browse code in Project" }).click();
    await popover.locator(".workspace-code__branch").getByText(branch, { exact: true }).waitFor();
    expect(await popover.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    if (process.env.BATTY_UI_SCREENSHOTS === "1")
      await page.screenshot({ path: ".tmp/ui-feedback/branch-header-long-390.png" });
    await popover.getByRole("button", { name: "Close code browser" }).click();
    await page.locator("#tools").evaluate((element) => (element as HTMLElement).hidePopover());
    await page.locator("#tools").evaluate((element) => (element as HTMLElement).showPopover());
    const row = page.getByRole("button", { name: "Browse code in Project" });
    await row.locator(".tools-popover__branch").getByText(branch, { exact: true }).waitFor();
    expect(await row.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(
      await page
        .getByRole("button", { name: "Browse code in Other" })
        .locator(".tools-popover__branch")
        .count(),
    ).toBe(0);
    if (process.env.BATTY_UI_SCREENSHOTS === "1")
      await page.screenshot({ path: ".tmp/ui-feedback/branch-list-long-390.png" });
  } finally {
    await setBranch("feature/current-branch");
    await page.close();
  }
});

for (const engine of ["chromium", "webkit"] as const) {
  test(`${engine}: filename filtering renders a native hierarchy and preserves the original tree`, async () => {
    const instance = (engine === "webkit" ? await launchWebKit() : browser) as unknown as Browser;
    try {
      for (const width of engine === "webkit" ? [390] : [1280, 390]) {
        const page = await instance.newPage({ viewport: { width, height: 900 } });
        page.setDefaultTimeout(10_000);
        try {
          await page.goto(url);
          await page.getByRole("button", { name: "Browse code in Project" }).click();
          const popover = page.getByRole("dialog", { name: "Code in Project" });
          await popover.getByRole("treeitem", { name: "src", exact: true }).click();
          await popover.getByRole("treeitem", { name: "main.ts", exact: true }).click();
          await popover
            .locator("[data-line]")
            .filter({ hasText: "export const greeting" })
            .waitFor();
          await page.keyboard.press(engine === "webkit" ? "Meta+p" : "Control+p");
          const input = popover.getByRole("searchbox", { name: "Find file by name" });
          expect(await input.evaluate((element) => element === document.activeElement)).toBe(true);
          await input.fill("qUiCkNeEdLe");
          const filtered = popover.locator(".file-search__results");
          await expect.poll(() => filtered.getByRole("treeitem").count()).toBe(5);
          expect(await filtered.getByRole("tree").count()).toBe(1);
          expect(
            await filtered
              .getByRole("treeitem")
              .evaluateAll((items) =>
                items.map((item) => [
                  item.getAttribute("aria-label"),
                  item.getAttribute("aria-level"),
                ]),
              ),
          ).toEqual([
            ["another", "1"],
            ["QuickNeedle.ts", "2"],
            ["unopened", "1"],
            ["deeper", "2"],
            ["QuickNeedle.ts", "3"],
          ]);
          expect(await popover.getByRole("listbox").count()).toBe(0);
          if (process.env.BATTY_UI_SCREENSHOTS === "1") {
            await fs.mkdir(".tmp/ui-feedback", { recursive: true });
            await page.screenshot({
              path: `.tmp/ui-feedback/filtered-hierarchy-${engine}-${width}.png`,
            });
          }
          const folder = filtered.getByRole("treeitem", { name: "another", exact: true });
          expect(await folder.getAttribute("aria-expanded")).toBe("true");
          await folder.click();
          await expect
            .poll(() =>
              filtered.getByRole("treeitem", { name: "QuickNeedle.ts", exact: true }).count(),
            )
            .toBe(1);
          await folder.focus();
          await page.keyboard.press("ArrowRight");
          await expect
            .poll(() =>
              filtered.getByRole("treeitem", { name: "QuickNeedle.ts", exact: true }).count(),
            )
            .toBe(2);
          await input.focus();
          await input.press("ArrowDown");
          expect(
            await folder.evaluate(
              (item) => (item.getRootNode() as ShadowRoot).activeElement === item,
            ),
          ).toBe(true);
          await page.keyboard.press("ArrowDown");
          await page.keyboard.press("Enter");
          await popover.locator("[data-line]").filter({ hasText: "export const found" }).waitFor();
          expect(await popover.locator(".full-popover__subtitle").textContent()).toBe(
            "another/QuickNeedle.ts",
          );
          if (width < 600)
            await popover.getByRole("button", { name: "Files", exact: true }).click();
          expect(await input.inputValue()).toBe("qUiCkNeEdLe");
          expect(
            await filtered
              .locator('[data-item-path="another/QuickNeedle.ts"]')
              .getAttribute("aria-selected"),
          ).toBe("true");
          await input.press("Escape");
          expect(
            await popover
              .getByRole("treeitem", { name: "src", exact: true })
              .getAttribute("aria-expanded"),
          ).toBe("true");
          expect(
            await popover
              .getByRole("treeitem", { name: "main.ts", exact: true })
              .getAttribute("aria-selected"),
          ).toBe("true");
          expect(await popover.locator(".full-popover__subtitle").textContent()).toBe(
            "another/QuickNeedle.ts",
          );
          await popover.getByRole("button", { name: "Find file", exact: true }).click();
          await input.fill("unopened");
          await popover.getByText("No files found.", { exact: true }).waitFor();
          await input.fill("HiddenNeedle");
          const hidden = filtered.getByRole("treeitem", { name: "HiddenNeedle.ts", exact: true });
          await hidden.waitFor();
          expect(
            await filtered
              .getByRole("treeitem")
              .evaluateAll((items) => items.map((item) => item.getAttribute("aria-label"))),
          ).toEqual([".git", "objects", "HiddenNeedle.ts"]);
          if (process.env.BATTY_UI_SCREENSHOTS === "1") {
            await fs.mkdir(".tmp/ui-feedback", { recursive: true });
            await page.screenshot({
              path: `.tmp/ui-feedback/file-search-tree-${engine}-${width}.png`,
            });
          }
          await hidden.focus();
          await page.keyboard.press("Escape");
          expect(await input.inputValue()).toBe("");
          expect(await popover.isVisible()).toBe(true);
          await input.press("Escape");
          expect(await popover.isVisible()).toBe(false);
          const shortcut = await page.evaluate(() => {
            const event = new KeyboardEvent("keydown", {
              key: "p",
              ctrlKey: true,
              bubbles: true,
              cancelable: true,
            });
            document.body.dispatchEvent(event);
            return event.defaultPrevented;
          });
          expect(shortcut).toBe(false);
        } finally {
          await page.close();
        }
      }
    } finally {
      if (engine === "webkit") await instance.close();
    }
  });
}

test("incremental matches preserve collapsed folders, open new parents, and flush the last batch", async () => {
  const page = await browser.newPage();
  page.setDefaultTimeout(10_000);
  try {
    await page.goto(url);
    await page.getByRole("button", { name: "Browse code in Project" }).click();
    const popover = page.getByRole("dialog", { name: "Code in Project" });
    await popover.getByRole("treeitem", { name: "src", exact: true }).waitFor();
    await popover.getByRole("searchbox", { name: "Find file by name" }).fill("needle-stream");
    const filtered = popover.locator(".file-search__results");
    const one = filtered.getByRole("treeitem", { name: "one", exact: true });
    await filtered.getByRole("treeitem", { name: "needle-stream.ts", exact: true }).waitFor();
    await one.click();
    expect(await one.getAttribute("aria-expanded")).toBe("false");
    incrementalSearch!.enqueue({ kind: "match", path: "one/needle-stream-two.ts" });
    incrementalSearch!.enqueue({ kind: "match", path: "two/needle-stream.ts" });
    incrementalSearch!.enqueue({ kind: "done" });
    incrementalSearch!.close();
    incrementalSearch = undefined;
    await filtered.getByRole("treeitem", { name: "two", exact: true }).waitFor();
    await expect.poll(() => popover.getByText("Searching…", { exact: true }).count()).toBe(0);
    expect(await one.getAttribute("aria-expanded")).toBe("false");
    expect(
      await filtered
        .getByRole("treeitem", { name: "two", exact: true })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(
      await filtered.getByRole("treeitem", { name: "needle-stream.ts", exact: true }).count(),
    ).toBe(1);
    await one.click();
    await filtered.getByRole("treeitem", { name: "needle-stream-two.ts", exact: true }).waitFor();
    expect(
      await filtered.getByRole("treeitem", { name: "needle-stream.ts", exact: true }).count(),
    ).toBe(2);
  } finally {
    incrementalSearch?.close();
    incrementalSearch = undefined;
    await page.close();
  }
});

test("search errors and newer queries do not turn partial or stale results into successful matches", async () => {
  const page = await browser.newPage();
  page.setDefaultTimeout(10_000);
  try {
    await fixtureOperation(server, page, "workspace.search", async (input, _context, next) => {
      if (input.name !== "broken") return next();
      return {
        value: null,
        events: new ReadableStream({
          start(controller) {
            controller.enqueue({ kind: "match", path: "partial/match.ts" });
            controller.enqueue({ kind: "error", message: "Permission denied" });
            controller.close();
          },
        }),
      };
    });
    await page.goto(url);
    await page.getByRole("button", { name: "Browse code in Project" }).click();
    const popover = page.getByRole("dialog", { name: "Code in Project" });
    await popover.getByRole("treeitem", { name: "src", exact: true }).waitFor();
    const input = popover.getByRole("searchbox", { name: "Find file by name" });
    await input.fill("broken");
    await popover
      .getByRole("alert")
      .filter({ hasText: "Search incomplete: Permission denied" })
      .waitFor();
    expect(await popover.getByText("No files found.", { exact: true }).count()).toBe(0);
    await popover
      .locator(".file-search__results")
      .getByRole("treeitem", { name: "match.ts", exact: true })
      .waitFor();
    let finish!: () => void;
    const delayed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let started!: () => void;
    const requested = new Promise<void>((resolve) => {
      started = resolve;
    });
    await fixtureOperation(server, page, "workspace.search", async (input, _context, next) => {
      if (input.name !== "slow") return next();
      started();
      await delayed;
      return {
        value: null,
        events: new ReadableStream({
          start(controller) {
            controller.enqueue({ kind: "match", path: "stale.ts" });
            controller.enqueue({ kind: "done" });
            controller.close();
          },
        }),
      };
    });
    await input.fill("slow");
    await requested;
    await input.fill("HiddenNeedle");
    await popover
      .locator(".file-search__results")
      .getByRole("treeitem", { name: "HiddenNeedle.ts", exact: true })
      .waitFor();
    finish();
    await expect
      .poll(() =>
        popover
          .locator(".file-search__results")
          .getByRole("treeitem")
          .evaluateAll((items) => items.map((item) => item.getAttribute("aria-label"))),
      )
      .toEqual([".git", "objects", "HiddenNeedle.ts"]);
    expect(await popover.getByRole("alert").count()).toBe(0);
  } finally {
    await page.close();
  }
});

test("workspace rows contain wrapped names and paths on desktop and mobile", async () => {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    try {
      await page.goto(url);
      const list = page.locator("#tools-Workspaces-panel");
      await list.getByRole("button", { name: "Browse code in Project" }).waitFor();
      const rows = await list.locator(".tools-popover__workspace").evaluateAll((elements) =>
        elements.map((element) => {
          const row = element.getBoundingClientRect();
          return {
            height: row.height,
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth,
            childrenContained: [...element.children].every((child) => {
              const box = child.getBoundingClientRect();
              return (
                box.top >= row.top &&
                box.bottom <= row.bottom &&
                box.right <= row.right &&
                box.left >= row.left
              );
            }),
            detailWeight: getComputedStyle(element.querySelector("code")!).fontWeight,
          };
        }),
      );
      expect(rows.every((row) => row.childrenContained && row.scrollWidth <= row.clientWidth)).toBe(
        true,
      );
      expect(rows.every((row) => row.detailWeight === "400")).toBe(true);
      expect(rows[0]!.height).toBeGreaterThan(44);
      if (width === 390) expect(rows[2]!.height).toBeGreaterThan(rows[0]!.height);
      if (process.env.BATTY_UI_SCREENSHOTS === "1") {
        await fs.mkdir(".tmp/ui-feedback", { recursive: true });
        await page.screenshot({ path: `.tmp/ui-feedback/workspace-list-${width}.png` });
      }
      await list.getByRole("button", { name: "Browse code in Project" }).click();
      await page
        .getByRole("dialog", { name: "Code in Project" })
        .getByRole("treeitem", { name: "src", exact: true })
        .waitFor();
    } finally {
      await page.close();
    }
  }
});

for (const engine of ["chromium", "webkit"] as const) {
  test(`${engine}: code wraps spaced lines and long tokens without changing text`, async () => {
    const instance = (engine === "webkit" ? await launchWebKit() : browser) as unknown as Browser;
    try {
      for (const width of engine === "webkit" ? [390] : [1280, 390]) {
        const page = await instance.newPage({ viewport: { width, height: 900 } });
        page.setDefaultTimeout(10_000);
        try {
          await page.goto(url);
          await page.getByRole("button", { name: "Browse code in Project" }).click();
          const popover = page.getByRole("dialog", { name: "Code in Project" });
          await popover.getByRole("treeitem", { name: "src", exact: true }).click();
          await popover.getByRole("treeitem", { name: "long.ts", exact: true }).click();
          await popover
            .locator("[data-line]")
            .filter({ hasText: "export const sentence" })
            .waitFor();
          await expect
            .poll(() => popover.locator("[data-line] span").count(), { timeout: 10_000 })
            .toBeGreaterThan(3);
          const lines = await popover.locator("[data-line]").evaluateAll((elements) =>
            elements.map((element) => ({
              text: element.textContent?.replace(/\\n$/, ""),
              height: element.getBoundingClientRect().height,
              lineHeight: parseFloat(getComputedStyle(element).lineHeight),
              scrollWidth: element.scrollWidth,
              clientWidth: element.clientWidth,
            })),
          );
          expect(lines.map((line) => line.text)).toEqual(wrappedSource.split("\n"));
          expect(lines.slice(0, 2).every((line) => line.height > line.lineHeight * 2)).toBe(true);
          expect(lines.every((line) => line.scrollWidth <= line.clientWidth + 1)).toBe(true);
          const viewer = await popover
            .locator(".workspace-code__viewer")
            .evaluate((element) => ({ scroll: element.scrollWidth, width: element.clientWidth }));
          expect(viewer.scroll).toBeLessThanOrEqual(viewer.width);
          if (process.env.BATTY_UI_SCREENSHOTS === "1") {
            await fs.mkdir(".tmp/ui-feedback", { recursive: true });
            await page.screenshot({ path: `.tmp/ui-feedback/wrapped-code-${engine}-${width}.png` });
          }
        } finally {
          await page.close();
        }
      }
    } finally {
      if (engine === "webkit") await instance.close();
    }
  });
}

test("directory failures are visible and retryable, file failures do not leave stale source", async () => {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  let fail = true;
  try {
    await fixtureOperation(server, page, "workspace.files", async (input, _context, next) => {
      if (input.path === "src" && fail) throw new RpcError("INTERNAL", "Directory unavailable");
      return next();
    });
    await page.goto(url);
    await page.getByRole("button", { name: "Browse code in Project" }).click();
    const popover = page.locator("#tools-code");
    await popover.getByRole("treeitem", { name: "src", exact: true }).click();
    await popover.getByRole("alert").filter({ hasText: "Directory unavailable" }).waitFor();
    fail = false;
    await popover.getByRole("button", { name: "Retry", exact: true }).click();
    await popover.getByRole("treeitem", { name: "main.ts", exact: true }).click();
    await popover.locator("[data-line]").filter({ hasText: "export const greeting" }).waitFor();
    await fixtureOperation(
      server,
      page,
      ["workspace.files", "workspace.file"],
      async (input, _context, next) => {
        if (input.path === ".hidden") throw new RpcError("FORBIDDEN", "Path leaves the workspace");
        return next();
      },
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
