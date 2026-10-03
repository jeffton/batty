import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { drainDeployment, startDeploymentControl } from "./deployment-control";

const roots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-deployment-control-"));
  roots.push(root);
  await fs.mkdir(path.join(root, ".batty"));
  return root;
}

function deploymentSocket(root: string): string {
  if (process.platform === "win32") {
    const hash = createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 32);
    return `\\\\.\\pipe\\batty-deployment-${hash}`;
  }
  return path.join(root, ".batty", "deployment.sock");
}

function listen(server: net.Server, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", resolve);
    server.listen(address);
  });
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("deployment control", () => {
  it("waits for checkpoint completion before acknowledging", async () => {
    const root = await createRoot();
    let complete!: () => void;
    const completed = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const control = await startDeploymentControl(root, () => completed);

    try {
      let resolved = false;
      const draining = drainDeployment(root).then(() => {
        resolved = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(resolved).toBe(false);
      complete();
      await expect(draining).resolves.toBeUndefined();
      if (process.platform !== "win32") {
        const mode = (await fs.stat(deploymentSocket(root))).mode & 0o777;
        expect(mode).toBe(0o600);
      }
    } finally {
      await control.close();
    }
  });

  it("forwards only the initiating session identity without an all-turn wait", async () => {
    const root = await createRoot();
    const received: Array<[string | undefined, string | undefined]> = [];
    const control = await startDeploymentControl(root, async (sessionPath, afterEntryId) => {
      received.push([sessionPath, afterEntryId]);
    });
    try {
      const sessionPath = path.join(root, 'session "quoted" with spaces.sqlite');
      await drainDeployment(root, sessionPath, "tool-use-entry");
      await drainDeployment(root);
      expect(received).toEqual([[sessionPath, "tool-use-entry"]]);
    } finally {
      await control.close();
    }
  });

  it("coalesces concurrent clients behind the initiating response and caches success", async () => {
    const root = await createRoot();
    let complete!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const checkpoint = vi.fn(() => {
      started();
      return pending;
    });
    const control = await startDeploymentControl(root, checkpoint);
    try {
      const first = drainDeployment(root, "/initiating.sqlite", "tool-use-entry");
      await ready;
      let secondResolved = false;
      const second = drainDeployment(root).then(() => {
        secondResolved = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(secondResolved).toBe(false);
      expect(checkpoint).toHaveBeenCalledExactlyOnceWith("/initiating.sqlite", "tool-use-entry");
      complete();
      await Promise.all([first, second]);
      await drainDeployment(root, "/other.sqlite", "another-entry");
      expect(checkpoint).toHaveBeenCalledTimes(1);
    } finally {
      await control.close();
    }
  });

  it("retries a failed checkpoint and reports its error", async () => {
    const root = await createRoot();
    const failure = new Error("checkpoint failed");
    const checkpoint = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    const control = await startDeploymentControl(root, checkpoint);
    try {
      await expect(drainDeployment(root)).rejects.toThrow("closed before checkpoint completed");
      expect(report).toHaveBeenCalledWith("Deployment checkpoint failed", failure);
      await expect(drainDeployment(root)).resolves.toBeUndefined();
      expect(checkpoint).toHaveBeenCalledTimes(2);
    } finally {
      await control.close();
      report.mockRestore();
    }
  });

  it.each([
    ["/session.sqlite", undefined],
    [undefined, "entry"],
    ["", "entry"],
    ["/session.sqlite", ""],
  ])("rejects incomplete response identity %s / %s", async (sessionPath, afterEntryId) => {
    const root = await createRoot();
    const checkpoint = vi.fn().mockResolvedValue(undefined);
    const control = await startDeploymentControl(root, checkpoint);
    try {
      await expect(drainDeployment(root, sessionPath, afterEntryId)).rejects.toThrow(
        "closed before checkpoint completed",
      );
      expect(checkpoint).not.toHaveBeenCalled();
    } finally {
      await control.close();
    }
  });

  it("rejects when the server disconnects before acknowledgement", async () => {
    const root = await createRoot();
    const server = net.createServer((socket) => socket.once("data", () => socket.end()));
    await listen(server, deploymentSocket(root));

    try {
      await expect(drainDeployment(root)).rejects.toThrow("closed before checkpoint completed");
    } finally {
      await close(server);
    }
  });

  it.skipIf(process.platform === "win32")("replaces a stale socket", async () => {
    const root = await createRoot();
    await fs.writeFile(deploymentSocket(root), "stale");
    const control = await startDeploymentControl(root, async () => {});

    try {
      await expect(drainDeployment(root)).resolves.toBeUndefined();
    } finally {
      await control.close();
    }
  });

  it.skipIf(process.platform === "win32")("does not replace a live socket", async () => {
    const root = await createRoot();
    const socket = deploymentSocket(root);
    const active = net.createServer((connection) => connection.destroy());
    await listen(active, socket);

    try {
      await expect(startDeploymentControl(root, async () => {})).rejects.toThrow(
        "already listening",
      );
      await expect(fs.stat(socket)).resolves.toBeDefined();
    } finally {
      await close(active);
    }
  });
});
