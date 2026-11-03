// @vitest-environment node
import { expect, test, vi } from "vite-plus/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SshSocksProxy } from "./ssh-socks-proxy";

test.skipIf(process.platform !== "linux")(
  "cancelled SSH startup reaps its child and receipt before retry",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-proxy-timeout-"));
    const executable = path.join(root, "ssh");
    await fs.writeFile(executable, "#!/bin/sh\nexec sleep 60\n", { mode: 0o700 });
    const proxy = new SshSocksProxy("test", executable);
    proxy.setPersistenceRoot(root);
    const controller = new AbortController();
    try {
      const pending = proxy.ensureStarted(controller.signal);
      const rejected = expect(pending).rejects.toThrow("Stopped startup");
      const receipt = path.join(root, "ssh-proxy.json");
      await vi.waitFor(async () => expect(await fs.stat(receipt)).toBeDefined());
      const { pid } = JSON.parse(await fs.readFile(receipt, "utf8"));
      controller.abort(new Error("Stopped startup"));
      await rejected;
      expect(() => process.kill(pid, 0)).toThrow("ESRCH");
      await expect(fs.stat(receipt)).rejects.toThrow("ENOENT");
    } finally {
      await proxy.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
