import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { readBrowserJson, writeBrowserJson } from "./browser-persistence";
import net from "node:net";
import { stopBrowserChild } from "./browser-process";
import { browserAbortable } from "./browser-abort";
import { setTimeout as delay } from "node:timers/promises";

const START_TIMEOUT_MS = 15_000;

function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

async function availableLoopbackPort(): Promise<number> {
  const server = net.createServer();
  server.unref();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a SOCKS port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function assertLoopbackPortAvailable(port: number): Promise<void> {
  const server = net.createServer();
  server.unref();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
  } catch (error) {
    throw new Error(`SOCKS port ${port} is unavailable`, { cause: error });
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
}

async function acceptsSocksConnections(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(250);
    socket.once("connect", () => socket.write(Buffer.from([0x05, 0x01, 0x00])));
    socket.once("data", (data) => finish(data.length >= 2 && data[0] === 0x05 && data[1] === 0x00));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
    socket.once("close", () => finish(false));
  });
}

const stopChild = stopBrowserChild;

export interface BrowserProxy {
  setPersistenceRoot?(root: string): void;
  ensureStarted(signal?: AbortSignal): Promise<string>;
  dispose(): Promise<void>;
}

export class SshSocksProxy implements BrowserProxy {
  private child?: ChildProcess;
  private port?: number;
  private startPromise?: Promise<string>;
  private startupController?: AbortController;
  private startupWaiters = 0;
  private persistenceFile?: string;

  constructor(
    private readonly destination: string,
    private readonly sshPath = "ssh",
    private readonly allocatePort: () => Promise<number> = availableLoopbackPort,
  ) {}

  setPersistenceRoot(root: string): void {
    this.persistenceFile = path.join(root, "ssh-proxy.json");
  }

  async ensureStarted(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (this.startPromise) return this.waitForStartup(signal);
    if (!this.child && this.persistenceFile) {
      const receipt = await readBrowserJson<{ pid: number; port: number; destination: string }>(
        this.persistenceFile,
      );
      if (this.startPromise) return this.waitForStartup(signal);
      if (receipt) {
        if (receipt.destination !== this.destination)
          throw new Error(
            "Persistent browser SSH destination changed; close its browser sessions before changing routing",
          );
        process.kill(receipt.pid, 0);
        const deadline = Date.now() + START_TIMEOUT_MS;
        while (!(await acceptsSocksConnections(receipt.port))) {
          signal?.throwIfAborted();
          process.kill(receipt.pid, 0);
          if (Date.now() >= deadline)
            throw new Error("Persistent browser SSH tunnel is unavailable");
          await delay(50);
        }
        this.port = receipt.port;
        return this.serverUrl(receipt.port);
      }
    }
    if (
      this.child &&
      this.port &&
      isRunning(this.child) &&
      (await acceptsSocksConnections(this.port))
    ) {
      return this.serverUrl(this.port);
    }

    if (!this.startPromise) {
      this.startupController = new AbortController();
      const pending = this.start(this.startupController.signal).finally(() => {
        if (this.startPromise === pending) {
          this.startPromise = undefined;
          this.startupController = undefined;
        }
      });
      this.startPromise = pending;
    }
    return this.waitForStartup(signal);
  }

  private async waitForStartup(signal?: AbortSignal): Promise<string> {
    const pending = this.startPromise!;
    this.startupWaiters++;
    try {
      return await browserAbortable(pending, signal);
    } finally {
      this.startupWaiters--;
      if (!this.startupWaiters && signal?.aborted && this.startPromise === pending) {
        this.startupController!.abort(signal.reason);
        // The final consumer owns cancellation cleanup; concurrent consumers
        // retain the shared startup independently of this worker's lifetime.
        await pending.catch(() => {});
      }
    }
  }

  async dispose(): Promise<void> {
    await this.startPromise?.catch(() => {});
    const child = this.child;
    this.child = undefined;
    if (child) await stopChild(child);
    if (this.persistenceFile) {
      const receipt = await readBrowserJson<{ pid: number }>(this.persistenceFile);
      if (receipt) {
        try {
          process.kill(-receipt.pid, "SIGTERM");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      await fs.rm(this.persistenceFile, { force: true });
    }
  }

  private async start(signal?: AbortSignal): Promise<string> {
    if (this.destination.startsWith("-")) {
      throw new Error("browserTailscaleSshDestination cannot start with a hyphen");
    }
    if (this.child) await stopChild(this.child);

    this.port ??= await this.allocatePort();
    const port = this.port;
    try {
      await assertLoopbackPortAvailable(port);
    } catch (error) {
      this.port = undefined;
      throw error;
    }
    let spawnError: Error | undefined;
    let stderr = "";
    let forwardingReady = false;
    const forwardingMessage = `Local forwarding listening on 127.0.0.1 port ${port}.`;
    const logPath = this.persistenceFile
      ? path.join(path.dirname(this.persistenceFile), "ssh-proxy.log")
      : undefined;
    if (logPath) await fs.mkdir(path.dirname(logPath), { recursive: true, mode: 0o700 });
    signal?.throwIfAborted();
    const log = logPath ? await fs.open(logPath, "w", 0o600) : undefined;
    const child = spawn(
      this.sshPath,
      [
        "-v",
        "-NT",
        "-D",
        `127.0.0.1:${port}`,
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=15",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "ServerAliveInterval=30",
        "-o",
        "ServerAliveCountMax=3",
        this.destination,
      ],
      { detached: !!this.persistenceFile, stdio: ["ignore", "ignore", log?.fd ?? "pipe"] },
    );
    this.child = child;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-4_000);
      forwardingReady ||= stderr.includes(forwardingMessage);
    });
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("exit", () => {
      if (this.child === child) this.child = undefined;
    });

    try {
      await log?.close();
      if (this.persistenceFile && child.pid)
        await writeBrowserJson(this.persistenceFile, {
          pid: child.pid,
          port,
          destination: this.destination,
        });
      const deadline = Date.now() + START_TIMEOUT_MS;
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        if (spawnError) throw spawnError;
        if (!isRunning(child)) {
          throw new Error(stderr.trim() || `SSH tunnel exited before becoming ready`);
        }
        if (logPath) {
          stderr = (await fs.readFile(logPath, "utf8")).slice(-4_000);
          forwardingReady ||= stderr.includes(forwardingMessage);
        }
        if (forwardingReady && (await acceptsSocksConnections(port))) {
          if (this.persistenceFile) {
            await writeBrowserJson(this.persistenceFile, {
              pid: child.pid,
              port,
              destination: this.destination,
            });
            child.unref();
          }
          return this.serverUrl(port);
        }
        await delay(50);
      }

      throw new Error(
        `SSH SOCKS tunnel did not become ready within ${START_TIMEOUT_MS / 1_000} seconds`,
      );
    } catch (error) {
      await stopChild(child);
      if (this.persistenceFile) await fs.rm(this.persistenceFile, { force: true });
      throw error;
    }
  }

  private serverUrl(port: number): string {
    return `socks5://127.0.0.1:${port}`;
  }
}
