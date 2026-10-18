// @vitest-environment node
import { test, expect } from "vite-plus/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium } from "patchright";
import {
  prepareBrowserIsolation,
  removeBrowserIsolation,
  ownsBrowserProcess,
} from "./browser-isolation";
import { copyIsolatedBrowserDownload } from "./browser-download";

test.skipIf(process.platform !== "linux" || process.getuid?.() !== 0)(
  "browser-controlled download symlinks cannot make root extract private files",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-download-boundary-"));
    try {
      const isolation = (await prepareBrowserIsolation(root, chromium.executablePath()))!;
      // A forged browser profile lock cannot redirect lifecycle signals at the service.
      await expect(ownsBrowserProcess(root, process.pid)).rejects.toThrow(
        "belongs to another process",
      );
      const secret = path.join(root, "root-only-secret");
      await fs.writeFile(secret, "synthetic root-only secret", { mode: 0o600 });
      const source = path.join(isolation.directory, "artifacts", "malicious-download");
      await promisify(execFile)("/usr/bin/setpriv", [
        `--reuid=${isolation.uid}`,
        `--regid=${isolation.gid}`,
        "--clear-groups",
        "--",
        "/bin/ln",
        "-s",
        secret,
        source,
      ]);
      const destination = path.join(root, "extracted");
      await expect(copyIsolatedBrowserDownload(source, destination, isolation)).rejects.toThrow(
        "Permission denied",
      );
      await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(secret, "utf8")).toBe("synthetic root-only secret");
    } finally {
      await removeBrowserIsolation(root);
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
