// @vitest-environment node
import { expect, test, vi } from "vite-plus/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { BrowserService } from "./browser-service";
import { browserSessionDirectory } from "./browser-persistence";
import { removeBrowserIsolation } from "./browser-isolation";

function controlDeadline() {
  const schedule = globalThis.setTimeout;
  let expire!: () => void;
  const timer = vi
    .spyOn(globalThis, "setTimeout")
    .mockImplementationOnce((callback, milliseconds, ...args) => {
      expect(milliseconds).toBe(1000);
      const handle = schedule(() => {}, milliseconds);
      expire = () => {
        clearTimeout(handle);
        callback(...args);
      };
      return handle;
    });
  return { expire: () => expire(), restore: () => timer.mockRestore() };
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-action-timeout-"));
  const website = http.createServer((_, response) => response.end("<h1>Ready</h1>"));
  website.listen(0, "127.0.0.1");
  await once(website, "listening");
  const url = `http://127.0.0.1:${(website.address() as { port: number }).port}/`;
  const service = new BrowserService(undefined, 4, root);
  const directory = browserSessionDirectory(root, "worker");
  return {
    service,
    directory,
    url,
    async close() {
      await service.closeSession("worker");
      await service.dispose();
      website.closeAllConnections();
      await new Promise<void>((resolve) => website.close(() => resolve()));
      await removeBrowserIsolation(directory);
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

test.each(["pages", "evaluate", "registry"] as const)(
  "%s deadline and caller abort interrupt execution, release the queue and preserve the profile",
  async (stage) => {
    const action = stage === "registry" ? "pages" : stage;
    const fixtureState = await fixture();
    const { service, directory, url } = fixtureState;
    const internals = service as unknown as {
      pagesResult(): Promise<never>;
      performPageAction(): Promise<unknown>;
      persistRegistry(): Promise<never>;
    };
    try {
      await service.execute("worker", { action: "open", url });
      await service.execute("worker", {
        action: "evaluate",
        script: "() => localStorage.setItem('retained', 'yes')",
      });
      for (const interrupted of [false, true]) {
        // Metadata and persistence have no locator timeout; evaluate awaits a real page promise.
        const stalled =
          stage === "evaluate"
            ? vi.spyOn(internals, "performPageAction")
            : vi
                .spyOn(internals, stage === "registry" ? "persistRegistry" : "pagesResult")
                .mockImplementation(() => new Promise(() => {}));
        const controller = new AbortController();
        const deadline = controlDeadline();
        const pending = service.execute(
          "worker",
          {
            action,
            script: action === "evaluate" ? "() => new Promise(() => {})" : undefined,
            timeoutMs: 1000,
          },
          controller.signal,
        );
        const rejected = expect(pending).rejects.toThrow(
          interrupted ? "Caller stopped" : `Browser ${action} exceeded timeoutMs (1000 ms)`,
        );
        await vi.waitFor(() => expect(stalled).toHaveBeenCalled());
        const { pid } = JSON.parse(await fs.readFile(path.join(directory, "process.json"), "utf8"));
        deadline.restore();
        if (interrupted) controller.abort(new Error("Caller stopped"));
        else deadline.expire();
        await rejected;
        expect(() => process.kill(pid, 0)).toThrow("ESRCH");
        expect(await service.hasSession("worker")).toBe(false);
        expect(await fs.stat(path.join(directory, "profile"))).toBeDefined();
        stalled.mockRestore();
        expect((await service.execute("worker", { action: "open", url })).text).toContain("Ready");
        expect(
          (
            await service.execute("worker", {
              action: "evaluate",
              script: "() => localStorage.getItem('retained')",
            })
          ).text,
        ).toContain("Evaluation result:\nyes");
      }
    } finally {
      vi.restoreAllMocks();
      await fixtureState.close();
    }
  },
  25_000,
);

test("queued action timeout and abort preserve the running predecessor and queue order", async () => {
  const fixtureState = await fixture();
  const { service, url } = fixtureState;
  const internals = service as unknown as {
    serialized<T>(id: string, operation: () => Promise<T>): Promise<T>;
    pagesResult(): Promise<unknown>;
  };
  try {
    await service.execute("worker", { action: "open", url });
    const close = vi.spyOn(service, "closeSession");
    const pages = vi.spyOn(internals, "pagesResult");
    for (const interrupted of [false, true]) {
      let release!: () => void;
      const predecessor = internals.serialized(
        "worker",
        () => new Promise<void>((resolve) => (release = resolve)),
      );
      const controller = new AbortController();
      const deadline = controlDeadline();
      const waiting = service.execute(
        "worker",
        { action: "pages", timeoutMs: 1000 },
        controller.signal,
      );
      deadline.restore();
      const rejected = expect(waiting).rejects.toThrow(
        interrupted ? "Caller stopped" : "Browser pages exceeded timeoutMs (1000 ms)",
      );
      let overtook = false;
      const following = internals.serialized("worker", async () => {
        overtook = true;
      });
      try {
        await vi.waitFor(() => expect(release).toBeDefined());
        if (interrupted) controller.abort(new Error("Caller stopped"));
        else deadline.expire();
        await rejected;
        expect(close).not.toHaveBeenCalled();
        expect(pages).not.toHaveBeenCalled();
        expect(overtook).toBe(false);
        expect(await service.hasSession("worker")).toBe(true);
      } finally {
        release();
        await Promise.all([predecessor, following]);
      }
      expect(overtook).toBe(true);
    }
    expect((await service.execute("worker", { action: "pages" })).text).toContain("page-1");
  } finally {
    vi.restoreAllMocks();
    await fixtureState.close();
  }
});

test.each(["startup", "close"] as const)(
  "stalled %s cleanup returns an error but fences following actions until cleanup finishes",
  async (stage) => {
    const fixtureState = await fixture();
    const { service, url } = fixtureState;
    const internals = service as unknown as {
      pagesResult(): Promise<never>;
      startups: Map<string, Promise<unknown>>;
      serialized<T>(id: string, operation: () => Promise<T>): Promise<T>;
    };
    let resumeCleanup!: () => void;
    const stalledCleanup = new Promise<void>((resolve) => (resumeCleanup = resolve));
    try {
      await service.execute("worker", { action: "open", url });
      const pages = vi
        .spyOn(internals, "pagesResult")
        .mockImplementation(() => new Promise(() => {}));
      const originalClose = service.closeSession.bind(service);
      const close = vi.spyOn(service, "closeSession");
      if (stage === "startup") internals.startups.set("worker", stalledCleanup);
      else
        close.mockImplementation(async (id) => {
          await stalledCleanup;
          await originalClose(id);
        });
      const controller = new AbortController();
      const pending = service.execute("worker", { action: "pages" }, controller.signal);
      const rejected = expect(pending).rejects.toThrow(
        "Browser cancellation cleanup failed or exceeded 15000 ms",
      );
      await vi.waitFor(() => expect(pages).toHaveBeenCalled());
      const cleanupDeadline = vi.spyOn(AbortSignal, "timeout").mockImplementationOnce((ms) => {
        expect(ms).toBe(15_000);
        const grace = new AbortController();
        queueMicrotask(() => grace.abort(new Error("Cleanup deadline exceeded")));
        return grace.signal;
      });
      controller.abort(new Error("Caller stopped"));
      await rejected;
      cleanupDeadline.mockRestore();
      if (stage === "startup") expect(close).not.toHaveBeenCalled();
      else expect(close).toHaveBeenCalledTimes(1);
      let followingRan = false;
      const following = internals.serialized("worker", async () => {
        followingRan = true;
      });
      const deadline = controlDeadline();
      const queued = service.execute("worker", { action: "pages", timeoutMs: 1000 });
      deadline.restore();
      const queuedRejected = expect(queued).rejects.toThrow("Browser pages exceeded timeoutMs");
      deadline.expire();
      await queuedRejected;
      expect(followingRan).toBe(false);
      expect(pages).toHaveBeenCalledTimes(1);
      if (stage === "startup") internals.startups.delete("worker");
      resumeCleanup();
      await following;
      expect(followingRan).toBe(true);
      expect(await service.hasSession("worker")).toBe(false);
      pages.mockRestore();
      close.mockRestore();
      expect((await service.execute("worker", { action: "open", url })).text).toContain("Ready");
    } finally {
      internals.startups.delete("worker");
      resumeCleanup();
      vi.restoreAllMocks();
      await fixtureState.close();
    }
  },
  15_000,
);

test.each([false, true])(
  "close retains its lifecycle barrier after caller interruption (%s)",
  async (interrupted) => {
    const fixtureState = await fixture();
    const { service, url } = fixtureState;
    const internals = service as unknown as { pageForOpen(): Promise<unknown> };
    let finishClose!: () => void;
    const closing = new Promise<void>((resolve) => (finishClose = resolve));
    try {
      await service.execute("worker", { action: "open", url });
      const originalClose = service.closeSession.bind(service);
      const close = vi.spyOn(service, "closeSession").mockImplementation(async (id) => {
        await closing;
        await originalClose(id);
      });
      const lifecycle = vi.spyOn(service, "withSessionLifecycle");
      const opening = vi.spyOn(internals, "pageForOpen");
      const controller = new AbortController();
      const deadline = controlDeadline();
      const pending = service.execute(
        "worker",
        { action: "close", timeoutMs: 1000 },
        controller.signal,
      );
      deadline.restore();
      const rejected = expect(pending).rejects.toThrow(
        interrupted ? "Caller stopped" : "Browser close exceeded timeoutMs",
      );
      await vi.waitFor(() => expect(close).toHaveBeenCalled());
      if (interrupted) controller.abort(new Error("Caller stopped"));
      else deadline.expire();
      await rejected;
      const next = service.execute("worker", { action: "open", url });
      await vi.waitFor(() => expect(lifecycle).toHaveBeenCalledTimes(2));
      expect(opening).not.toHaveBeenCalled();
      finishClose();
      expect((await next).text).toContain("Ready");
      close.mockRestore();
    } finally {
      finishClose();
      vi.restoreAllMocks();
      await fixtureState.close();
    }
  },
);

test("the action deadline also bounds browser close", async () => {
  const service = new BrowserService();
  const close = vi.spyOn(service, "closeSession").mockImplementation(() => new Promise(() => {}));
  try {
    const deadline = controlDeadline();
    const pending = service.execute("worker", { action: "close", timeoutMs: 1000 });
    deadline.restore();
    const rejected = expect(pending).rejects.toThrow("Browser close exceeded timeoutMs (1000 ms)");
    await vi.waitFor(() => expect(close).toHaveBeenCalled());
    deadline.expire();
    await rejected;
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    close.mockRestore();
    await service.dispose();
  }
});
