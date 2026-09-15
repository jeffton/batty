import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { once } from "node:events";
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

async function stopChild(child: ChildProcess): Promise<void> {
  if (!isRunning(child)) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(3_000)]);
  if (!isRunning(child)) return;
  child.kill("SIGKILL");
  await once(child, "exit");
}

export interface BrowserProxy {
  ensureStarted(): Promise<string>;
  dispose(): Promise<void>;
}

export class SshSocksProxy implements BrowserProxy {
  private child?: ChildProcess;
  private port?: number;
  private startPromise?: Promise<string>;

  constructor(
    private readonly destination: string,
    private readonly sshPath = "ssh",
    private readonly allocatePort: () => Promise<number> = availableLoopbackPort,
  ) {}

  async ensureStarted(): Promise<string> {
    if (
      this.child &&
      this.port &&
      isRunning(this.child) &&
      (await acceptsSocksConnections(this.port))
    ) {
      return this.serverUrl(this.port);
    }

    this.startPromise ??= this.start();
    const startPromise = this.startPromise;
    try {
      return await startPromise;
    } finally {
      if (this.startPromise === startPromise) this.startPromise = undefined;
    }
  }

  async dispose(): Promise<void> {
    await this.startPromise?.catch(() => {});
    const child = this.child;
    this.child = undefined;
    if (child) await stopChild(child);
  }

  private async start(): Promise<string> {
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
      { stdio: ["ignore", "ignore", "pipe"] },
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

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (!isRunning(child)) {
        throw new Error(stderr.trim() || `SSH tunnel exited before becoming ready`);
      }
      if (forwardingReady && (await acceptsSocksConnections(port))) {
        return this.serverUrl(port);
      }
      await delay(50);
    }

    await stopChild(child);
    throw new Error(
      `SSH SOCKS tunnel did not become ready within ${START_TIMEOUT_MS / 1_000} seconds`,
    );
  }

  private serverUrl(port: number): string {
    return `socks5://127.0.0.1:${port}`;
  }
}
