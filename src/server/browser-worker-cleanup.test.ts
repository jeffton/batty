// @vitest-environment node
import { expect, test, vi } from "vite-plus/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrowserService, workspaceBrowserKey } from "./browser-service";
import { browserSessionDirectory, writeBrowserJson } from "./browser-persistence";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { BROWSER_IDLE_RETENTION_MS, createWorkerBrowserCleanup } from "./browser-worker-cleanup";
import { OrchestrationDoc, WorkerDoc } from "./orchestration";

test("resume admission cannot interleave with expiry reading persisted activity", async () => {
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-browser-legacy-"));
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

test("startup and periodic sweeps cover main, interrupted and newly created conversations", async () => {
  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models: createModels(),
      registry: createRegistry(),
      env: () => new NodeExecutionEnv({ cwd: "/tmp" }),
    },
    context,
  );
  const main = await harness.root(context);
  const child = await main.commit(async (tx) => {
    const child = await tx.createConversation({ ownership: { kind: "ownerless" } });
    (await tx.doc(WorkerDoc, child.id)).isSubagent = true;
    (await tx.doc(OrchestrationDoc)).mainId = main.id;
    return child;
  }, context);
  const workspaces = ["roy"];
  const present = new Set([String(main.id), String(child.id), workspaceBrowserKey("roy")]);
  const browser = {
    hasSession: vi.fn(async (id: string) => present.has(id)),
    expireIdleSession: vi.fn(async () => {}),
    withSessionLifecycle: async <T>(_id: string, operation: () => Promise<T>) => operation(),
    closeSession: vi.fn(async () => {}),
  };
  const cleanup = createWorkerBrowserCleanup(browser, async () => workspaces);
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    await cleanup.bind(harness);
    for (const id of present)
      expect(browser.expireIdleSession).toHaveBeenCalledWith(id, BROWSER_IDLE_RETENTION_MS);
    const next = await main.commit(
      (tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
      context,
    );
    present.add(String(next.id));
    workspaces.push("project");
    present.add(workspaceBrowserKey("project"));
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() =>
      expect(browser.expireIdleSession).toHaveBeenCalledWith(
        String(next.id),
        BROWSER_IDLE_RETENTION_MS,
      ),
    );
    expect(browser.expireIdleSession).toHaveBeenCalledWith(
      workspaceBrowserKey("project"),
      BROWSER_IDLE_RETENTION_MS,
    );
    await main.commit(async (tx) => {
      (await tx.doc(OrchestrationDoc)).workers[String(child.id)] = {
        active: "worker-task",
      } as any;
    }, context);
    await cleanup.stop(harness, child.id, "worker-task");
    expect(browser.closeSession).toHaveBeenCalledWith(String(child.id));
    expect(browser.closeSession).not.toHaveBeenCalledWith(workspaceBrowserKey("roy"));
  } finally {
    await cleanup.close();
    vi.useRealTimers();
    await harness.close(context);
  }
});
