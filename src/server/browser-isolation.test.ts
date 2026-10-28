// @vitest-environment node
import { expect, test, vi } from "vite-plus/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "patchright";
import { prepareBrowserIsolation, removeBrowserIsolation } from "./browser-isolation";
import { browserExecutablePath } from "./browser-executable";
import { verifyBrowserIsolation } from "./browser-isolation-smoke";

test
  .skipIf(process.platform !== "linux" || process.getuid?.() !== 0)
  .each(["rename", "symlink"] as const)(
  "interrupted isolation %s resumes without losing the existing profile",
  async (operation) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "batty-isolation-retry-"));
    const profile = path.join(directory, "profile");
    await fs.mkdir(profile);
    await fs.writeFile(path.join(profile, "saved-login"), "retained");
    const failure = vi.spyOn(fs, operation).mockRejectedValueOnce(new Error("setup interrupted"));
    try {
      const executable = browserExecutablePath(() => chromium.executablePath());
      await expect(prepareBrowserIsolation(directory, executable)).rejects.toThrow(
        "setup interrupted",
      );
      failure.mockRestore();
      const isolation = await prepareBrowserIsolation(directory, executable);
      expect(await fs.readlink(profile)).toBe(path.join(isolation!.directory, "profile"));
      expect(await fs.readFile(path.join(profile, "saved-login"), "utf8")).toBe("retained");
      expect((await prepareBrowserIsolation(directory, executable))!.directory).toBe(
        isolation!.directory,
      );
    } finally {
      failure.mockRestore();
      await removeBrowserIsolation(directory);
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "linux" || process.getuid?.() !== 0)(
  "unprivileged Chromium uses namespace/seccomp sandbox with working upload, download and H.264",
  async () => {
    await expect(verifyBrowserIsolation()).resolves.toBeUndefined();
  },
  45_000,
);
