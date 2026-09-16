import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { once } from "node:events";
import net from "node:net";
import path from "node:path";

function socketPath(root: string): string {
  if (process.platform === "win32") {
    const hash = createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 32);
    return `\\\\.\\pipe\\batty-deployment-${hash}`;
  }

  return path.join(root, ".batty", "deployment.sock");
}

async function listen(server: net.Server, address: string): Promise<void> {
  server.listen(address);
  await once(server, "listening");
}

async function socketIsActive(address: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(address);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") {
        resolve(false);
        return;
      }
      reject(error);
    });
  });
}

async function listenWithStaleSocketRecovery(server: net.Server, address: string): Promise<void> {
  try {
    await listen(server, address);
  } catch (error) {
    if (process.platform === "win32" || (error as NodeJS.ErrnoException).code !== "EADDRINUSE") {
      throw error;
    }
    if (await socketIsActive(address)) {
      throw new Error(`Deployment control is already listening at ${address}`);
    }
    await fs.unlink(address);
    await listen(server, address);
  }
}

export async function startDeploymentControl(
  root: string,
  drain: () => Promise<void>,
): Promise<{ close(): Promise<void> }> {
  const address = socketPath(root);
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setEncoding("utf8");
    let input = "";

    socket.on("data", (chunk: string) => {
      input += chunk;
      if (input !== "drain\n") {
        if (input.length >= "drain\n".length || !"drain\n".startsWith(input)) {
          socket.destroy();
        }
        return;
      }
      socket.pause();
      void drain().then(
        () => socket.end("drained\n"),
        (error) => {
          console.error("Deployment drain failed", error);
          socket.destroy();
        },
      );
    });
  });

  await listenWithStaleSocketRecovery(server, address);
  if (process.platform !== "win32") {
    await fs.chmod(address, 0o600);
  }

  return {
    async close(): Promise<void> {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      if (process.platform !== "win32") {
        await fs.rm(address, { force: true });
      }
    },
  };
}

export async function drainDeployment(root: string): Promise<void> {
  const address = socketPath(root);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(address);
    let response = "";
    let settled = false;
    const fail = (error: Error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    socket.setEncoding("utf8");
    socket.once("error", fail);
    socket.once("close", () => {
      if (!settled) {
        fail(new Error("Deployment control closed before draining completed"));
      }
    });
    socket.on("data", (chunk: string) => {
      response += chunk;
      if (response === "drained\n") {
        settled = true;
        resolve();
        socket.destroy();
        return;
      }
      if (response.length >= "drained\n".length || !"drained\n".startsWith(response)) {
        fail(new Error("Unexpected deployment control response"));
        socket.destroy();
      }
    });
    socket.once("connect", () => socket.write("drain\n"));
  });
}
