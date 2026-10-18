// @vitest-environment node
import { expect, test, vi } from "vite-plus/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SshSocksProxy } from "./ssh-socks-proxy";

test.skipIf(process.platform !== "linux")(
  "one cancelled waiter does not cancel another worker's SSH startup",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-shared-proxy-"));
    const executable = path.join(root, "ssh.cjs");
    await fs.writeFile(
      executable,
      `#!/usr/bin/env node
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const port = Number(process.argv[process.argv.indexOf('-D') + 1].split(':')[1]);
const timer = setInterval(() => {
  if (!fs.existsSync(path.join(__dirname, 'ready'))) return;
  clearInterval(timer);
  net.createServer(socket => socket.on('data', () => socket.end(Buffer.from([5,0])))).listen(port, '127.0.0.1', () => {
    process.stderr.write('Local forwarding listening on 127.0.0.1 port ' + port + '.\\n');
  });
}, 20);
`,
      { mode: 0o700 },
    );
    const proxy = new SshSocksProxy("test", executable);
    proxy.setPersistenceRoot(root);
    const controller = new AbortController();
    try {
      const first = proxy.ensureStarted(controller.signal);
      const rejected = expect(first).rejects.toThrow("First worker stopped");
      const receipt = path.join(root, "ssh-proxy.json");
      await vi.waitFor(async () => expect(await fs.stat(receipt)).toBeDefined());
      const second = proxy.ensureStarted();
      controller.abort(new Error("First worker stopped"));
      await rejected;
      const { pid } = JSON.parse(await fs.readFile(receipt, "utf8"));
      expect(() => process.kill(pid, 0)).not.toThrow();
      await fs.writeFile(path.join(root, "ready"), "");
      expect(await second).toMatch(/^socks5:\/\/127\.0\.0\.1:/);
      expect(await proxy.ensureStarted()).toBe(await second);
    } finally {
      await proxy.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
