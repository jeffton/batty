// @vitest-environment node
import { expect, test, vi } from "vite-plus/test";
import fs from "node:fs/promises";
import { removeTestBrowserRoot } from "./test-browser-cleanup";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { BrowserService } from "./browser-service";
import type { Browser } from "patchright";
import { browserSessionDirectory } from "./browser-persistence";
import * as persistence from "./browser-persistence";
import { SshSocksProxy } from "./ssh-socks-proxy";

function controlOpenDeadline() {
  const schedule = globalThis.setTimeout;
  let expire!: () => void;
  const timer = vi
    .spyOn(globalThis, "setTimeout")
    .mockImplementationOnce((callback, delay, ...args) => {
      expect(delay).toBe(1000);
      // Keep a cancellable handle without allowing wall-clock time to end the operation.
      const handle = schedule(() => {}, delay);
      expire = () => {
        clearTimeout(handle);
        callback(...args);
      };
      return handle;
    });
  return { expire: () => expire(), restore: () => timer.mockRestore() };
}

test("open deadline and worker cancellation interrupt a hung snapshot and release the action queue", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-open-timeout-"));
  const website = http.createServer((_, response) => response.end("<h1>Ready</h1>"));
  website.listen(0, "127.0.0.1");
  await once(website, "listening");
  const url = `http://127.0.0.1:${(website.address() as { port: number }).port}/`;
  const disposeProxy = vi.fn(async () => {});
  const service = new BrowserService(
    { ensureStarted: async () => "unused", dispose: disposeProxy },
    4,
    root,
  );
  const directory = browserSessionDirectory(root, "worker");
  // This stage has no Playwright action/navigation timeout. Simulate a stalled
  // CDP evaluation that does not settle even when its caller stops waiting.
  const internals = service as unknown as {
    snapshotResult(): Promise<never>;
    serialized<T>(id: string, operation: () => Promise<T>): Promise<T>;
    sessions: Map<string, { browser: Browser; downloadDirs: Set<string> }>;
  };
  try {
    await service.execute("worker", { action: "open", url });
    for (const interrupted of [false, true]) {
      const snapshot = vi
        .spyOn(internals, "snapshotResult")
        .mockImplementation(() => new Promise(() => {}));
      const controller = new AbortController();
      const deadline = controlOpenDeadline();
      const pending = service.execute(
        "worker",
        { action: "open", url, timeoutMs: 1000 },
        controller.signal,
      );
      const rejected = expect(pending).rejects.toThrow(
        interrupted ? "Worker stopped" : "Browser open exceeded timeoutMs (1000 ms)",
      );
      await vi.waitFor(() => expect(snapshot).toHaveBeenCalled());
      const pid = JSON.parse(await fs.readFile(path.join(directory, "process.json"), "utf8")).pid;
      deadline.restore();
      if (interrupted) controller.abort(new Error("Worker stopped"));
      else deadline.expire();
      await rejected;
      expect(() => process.kill(pid, 0)).toThrow("ESRCH");
      expect(await service.hasSession("worker")).toBe(false);
      snapshot.mockRestore();
      // A new action must not queue behind the abandoned promise.
      expect(
        (await service.execute("worker", { action: "open", url, timeoutMs: 5000 })).text,
      ).toContain("Ready");
    }
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const predecessor = internals.serialized("worker", () => barrier);
    const close = vi.spyOn(service, "closeSession");
    try {
      const deadline = controlOpenDeadline();
      const waiting = service.execute("worker", { action: "open", url, timeoutMs: 1000 });
      deadline.restore();
      let overtook = false;
      const following = internals.serialized("worker", async () => {
        overtook = true;
      });
      const rejected = expect(waiting).rejects.toThrow("Browser open exceeded timeoutMs");
      deadline.expire();
      await rejected;
      expect(close).not.toHaveBeenCalled();
      expect(overtook).toBe(false);
      expect(await service.hasSession("worker")).toBe(true);
      release();
      await Promise.all([predecessor, following]);
      expect(overtook).toBe(true);
      expect((await service.execute("worker", { action: "pages" })).text).toContain("page-1");
    } finally {
      release();
      close.mockRestore();
    }
    const session = internals.sessions.get("worker")!;
    const download = await fs.mkdtemp(path.join(os.tmpdir(), "batty-timeout-download-"));
    session.downloadDirs.add(download);
    const proxyDisposals = disposeProxy.mock.calls.length;
    const disconnect = vi
      .spyOn(session.browser, "close")
      .mockImplementation(() => new Promise(() => {}));
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      expect(milliseconds).toBe(2000);
      const controller = new AbortController();
      queueMicrotask(() => controller.abort(new DOMException("Timed out", "TimeoutError")));
      return controller.signal;
    });
    try {
      await expect(service.closeSession("worker")).rejects.toThrow(
        "Browser session cleanup failed",
      );
      expect(disposeProxy).toHaveBeenCalledTimes(proxyDisposals + 1);
      await expect(fs.stat(download)).rejects.toThrow("ENOENT");
    } finally {
      timeout.mockRestore();
      disconnect.mockRestore();
    }
  } finally {
    vi.restoreAllMocks();
    await service.closeSession("worker");
    await service.dispose();
    website.closeAllConnections();
    await new Promise<void>((resolve) => website.close(() => resolve()));
    await removeTestBrowserRoot(root);
  }
}, 20_000);

test("startup preserves the original failure when cleanup also fails", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-startup-errors-"));
  const service = new BrowserService(undefined, 4, root);
  const startupError = new Error("Target inspection failed");
  const cleanupError = new Error("CDP disconnect failed");
  const target = vi
    .spyOn(service as unknown as { targetId(): Promise<string> }, "targetId")
    .mockRejectedValue(startupError);
  const originalClose = persistence.closePersistentBrowser;
  const close = vi
    .spyOn(persistence, "closePersistentBrowser")
    .mockImplementation(async (...args) => {
      await originalClose(...args);
      throw cleanupError;
    });
  try {
    await expect(
      service.execute("worker", { action: "open", url: "https://example.com" }),
    ).rejects.toMatchObject({ errors: [startupError, cleanupError] });
  } finally {
    target.mockRestore();
    close.mockRestore();
    await service.closeSession("worker");
    await removeTestBrowserRoot(root);
  }
});

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
