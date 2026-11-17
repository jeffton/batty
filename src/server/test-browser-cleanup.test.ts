// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vite-plus/test";
import { BrowserService } from "./browser-service";
import { browserSessionDirectory, readBrowserJson } from "./browser-persistence";
import { removeTestBrowserRoot } from "./test-browser-cleanup";

test.skipIf(process.platform !== "linux")(
  "fixture removal stops live Chrome and Xvfb before deleting their ownership receipts",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-owner-cleanup-"));
    const browser = new BrowserService(undefined, 4, root);
    try {
      await browser.openCloudBrowser("fixture");
      const directory = browserSessionDirectory(root, "fixture");
      const chrome = (await readBrowserJson<{ pid: number }>(
        path.join(directory, "browser.json"),
      ))!;
      const display = (await readBrowserJson<{ pid: number }>(
        path.join(directory, "display.json"),
      ))!;
      const isolation = (await readBrowserJson<{ directory: string }>(
        path.join(directory, "isolation.json"),
      ))!;
      await fs.access(`/proc/${chrome.pid}`);
      await fs.access(`/proc/${display.pid}`);
      await removeTestBrowserRoot(root);
      for (const file of [`/proc/${chrome.pid}`, `/proc/${display.pid}`, isolation.directory, root])
        await expect(fs.access(file)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await browser.closeSession("fixture");
      await browser.dispose();
      if (
        await fs.stat(root).then(
          () => true,
          () => false,
        )
      )
        await removeTestBrowserRoot(root);
    }
  },
  45_000,
);
