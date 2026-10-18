// @vitest-environment node
import { expect, test } from "vite-plus/test";
import { verifyBrowserIsolation } from "./browser-isolation-smoke";

test.skipIf(process.platform !== "linux" || process.getuid?.() !== 0)(
  "unprivileged Chromium uses namespace/seccomp sandbox with working upload, download and H.264",
  async () => {
    await expect(verifyBrowserIsolation()).resolves.toBeUndefined();
  },
  45_000,
);
