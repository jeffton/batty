import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { SshSocksProxy } from "@/server/ssh-socks-proxy";

const tempDirs: string[] = [];
const proxies: SshSocksProxy[] = [];

afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.dispose()));
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function executable(name: string, source: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "batty-ssh-proxy-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, `#!/usr/bin/env node\n${source}`, { mode: 0o700 });
  return filePath;
}

describe("SshSocksProxy", () => {
  it("starts one loopback dynamic forwarding process and reuses it", async () => {
    const sshPath = await executable(
      "fake-ssh",
      `
const fs = require("node:fs");
const net = require("node:net");
const args = process.argv.slice(2);
fs.writeFileSync(__filename + ".args", JSON.stringify(args));
const address = args[args.indexOf("-D") + 1];
const port = Number(address.split(":").at(-1));
const server = net.createServer((socket) => {
  socket.once("data", () => socket.end(Buffer.from([0x05, 0x00])));
});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`,
    );
    const proxy = new SshSocksProxy("david@summerhouse-pi", sshPath);
    proxies.push(proxy);

    const first = await proxy.ensureStarted();
    const second = await proxy.ensureStarted();
    const args = JSON.parse(await fs.readFile(`${sshPath}.args`, "utf8")) as string[];

    expect(first).toMatch(/^socks5:\/\/127\.0\.0\.1:\d+$/);
    expect(second).toBe(first);
    expect(args).toContain("-NT");
    expect(args).toContain("ExitOnForwardFailure=yes");
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args.at(-1)).toBe("david@summerhouse-pi");
  });

  it("rejects a colliding SOCKS listener instead of mistaking it for the SSH tunnel", async () => {
    const existingServer = net.createServer((socket) => {
      socket.once("data", () => socket.end(Buffer.from([0x05, 0x00])));
    });
    await new Promise<void>((resolve) => existingServer.listen(0, "127.0.0.1", resolve));
    const address = existingServer.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address");

    const sshPath = await executable(
      "colliding-ssh",
      `
const net = require("node:net");
const args = process.argv.slice(2);
const address = args[args.indexOf("-D") + 1];
const port = Number(address.split(":").at(-1));
net.createServer().listen(port, "127.0.0.1");
`,
    );
    const proxy = new SshSocksProxy("david@summerhouse-pi", sshPath, async () => address.port);
    proxies.push(proxy);

    try {
      await expect(proxy.ensureStarted()).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve, reject) =>
        existingServer.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("reports SSH startup errors instead of providing a direct fallback", async () => {
    const sshPath = await executable(
      "failing-ssh",
      `process.stderr.write("Permission denied (publickey).\\n"); process.exit(255);`,
    );
    const proxy = new SshSocksProxy("david@summerhouse-pi", sshPath);
    proxies.push(proxy);

    await expect(proxy.ensureStarted()).rejects.toThrow("Permission denied (publickey)");
  });
});
