// @vitest-environment node
import { expect, test, vi } from "vite-plus/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrowserService, workspaceBrowserKey } from "./browser-service";
import { browserSessionDirectory, writeBrowserJson } from "./browser-persistence";
import { BROWSER_IDLE_RETENTION_MS, createBrowserCleanup } from "./browser-cleanup";

test("browser admission cannot interleave with expiry reading persisted activity", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-browser-admission-"));
  const service = new BrowserService(undefined, 4, root);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let checked = false;
  let admitted = false;
  const originalStat = fs.stat;
  const stat = vi.spyOn(fs, "stat");
  try {
    const launch = path.join(browserSessionDirectory(root, "worker"), "launch.json");
    await writeBrowserJson(launch, { useTailscale: false });
    await fs.utimes(launch, new Date(0), new Date(0));
    stat.mockImplementation(async (...args: Parameters<typeof fs.stat>) => {
      if (args[0] === launch) {
        checked = true;
        await gate;
      }
      return originalStat(...args);
    });
    const expiry = service.expireIdleSession("worker", 100, 1_000);
    await vi.waitFor(() => expect(checked).toBe(true));
    const resume = service.withSessionLifecycle("worker", async () => {
      admitted = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(admitted).toBe(false);
    release();
    await Promise.all([expiry, resume]);
    expect(admitted).toBe(true);
    expect(await service.hasSession("worker")).toBe(false);
  } finally {
    release();
    stat.mockRestore();
    await service.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("queued browser calls prevent expiry until they settle", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-browser-queued-"));
  const service = new BrowserService(undefined, 4, root);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queues = (service as unknown as { queues: Map<string, Promise<void>> }).queues;
  const createSession = vi.spyOn(
    service as unknown as { createSession: () => Promise<never> },
    "createSession",
  );
  createSession.mockRejectedValue(new Error("Action interrupted"));
  try {
    const launch = path.join(browserSessionDirectory(root, "worker"), "launch.json");
    await writeBrowserJson(launch, { useTailscale: false });
    await fs.utimes(launch, new Date(0), new Date(0));
    // Hold admission without running a browser action.
    queues.set("worker", gate);
    const call = service.execute("worker", { action: "pages" });
    const rejected = expect(call).rejects.toThrow("Action interrupted");
    await service.expireIdleSession("worker", 100, 1_000);
    expect(await service.hasSession("worker")).toBe(true);
    expect(createSession).not.toHaveBeenCalled();
    release();
    await rejected;
    await fs.utimes(launch, new Date(0), new Date(0));
    await service.expireIdleSession("worker", 100, 1_000);
    expect(await service.hasSession("worker")).toBe(false);
  } finally {
    release();
    createSession.mockRestore();
    await service.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an active browser call prevents expiry until it settles", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-browser-active-"));
  const service = new BrowserService(undefined, 4, root);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const launch = path.join(browserSessionDirectory(root, "worker"), "launch.json");
  const createSession = vi.spyOn(
    service as unknown as { createSession: () => Promise<never> },
    "createSession",
  );
  let started = false;
  try {
    await writeBrowserJson(launch, { useTailscale: false });
    createSession.mockImplementation(async () => {
      started = true;
      await gate;
      throw new Error("Action interrupted");
    });
    const call = service.execute("worker", { action: "pages" });
    const rejected = expect(call).rejects.toThrow("Action interrupted");
    await vi.waitFor(() => expect(started).toBe(true));
    await fs.utimes(launch, new Date(0), new Date(0));
    await service.expireIdleSession("worker", 100, 1_000);
    expect(await service.hasSession("worker")).toBe(true);
    release();
    await rejected;
    await service.expireIdleSession("worker", 100, 1_000);
    expect(await service.hasSession("worker")).toBe(false);
  } finally {
    release();
    createSession.mockRestore();
    await service.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("existing browser registry activity is retained, not just its older launch time", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-browser-registry-"));
  const service = new BrowserService(undefined, 4, root);
  try {
    const directory = browserSessionDirectory(root, "main");
    await writeBrowserJson(path.join(directory, "launch.json"), { useTailscale: false });
    await writeBrowserJson(path.join(directory, "registry.json"), {});
    await fs.utimes(path.join(directory, "launch.json"), new Date(0), new Date(0));
    await fs.utimes(path.join(directory, "registry.json"), new Date(1_000), new Date(1_000));
    await service.expireIdleSession("main", BROWSER_IDLE_RETENTION_MS, BROWSER_IDLE_RETENTION_MS);
    expect(await service.hasSession("main")).toBe(true);
    await service.expireIdleSession(
      "main",
      BROWSER_IDLE_RETENTION_MS,
      BROWSER_IDLE_RETENTION_MS + 1_000,
    );
    expect(await service.hasSession("main")).toBe(false);
  } finally {
    await service.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("startup and periodic sweeps cover workspace browsers and newly added workspaces", async () => {
  const workspaces = ["roy"];
  const present = new Set([workspaceBrowserKey("roy"), workspaceBrowserKey("project")]);
  const browser = {
    hasSession: vi.fn(async (id: string) => present.has(id)),
    expireIdleSession: vi.fn(async () => {}),
  };
  const cleanup = createBrowserCleanup(browser, async () => workspaces);
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    await cleanup.bind();
    expect(browser.expireIdleSession.mock.calls).toEqual([
      [workspaceBrowserKey("roy"), BROWSER_IDLE_RETENTION_MS],
    ]);
    workspaces.push("project");
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() =>
      expect(browser.expireIdleSession).toHaveBeenCalledWith(
        workspaceBrowserKey("project"),
        BROWSER_IDLE_RETENTION_MS,
      ),
    );
  } finally {
    await cleanup.close();
    vi.useRealTimers();
  }
});
