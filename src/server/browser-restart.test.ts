// @vitest-environment node
import { expect, test } from "vite-plus/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { BrowserService } from "./browser-service";
import { browserSessionDirectory } from "./browser-persistence";
import { BROWSER_IDLE_RETENTION_MS } from "./browser-cleanup";
import { removeBrowserIsolation } from "./browser-isolation";

test.each(["main", "interrupted"])(
  "%s browser expires on inactivity across restart, but not during a browser call",
  async (owner) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-browser-retention-"));
    const server = http.createServer((_, response) =>
      response.end("<html><body>Retention</body></html>"),
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    let service = new BrowserService(undefined, 4, root);
    const lastUsed = async () => {
      const directory = browserSessionDirectory(root, owner);
      return Math.max(
        (await fs.stat(path.join(directory, "launch.json"))).mtimeMs,
        (await fs.stat(path.join(directory, "registry.json"))).mtimeMs,
      );
    };
    try {
      const first = await service.execute(owner, { action: "open", url });
      await service.execute(owner, {
        action: "evaluate",
        script:
          'globalThis.retained = 42; document.cookie = "login=retained; Max-Age=3600; Path=/"; localStorage.setItem("login", "retained")',
      });
      const beforeRestart = await lastUsed();
      await service.dispose();
      service = new BrowserService(undefined, 4, root);
      await service.expireIdleSession(
        owner,
        BROWSER_IDLE_RETENTION_MS,
        beforeRestart + 59 * 60_000,
      );
      expect(await service.hasSession(owner)).toBe(true);
      const restored = await service.execute(owner, {
        action: "evaluate",
        script: "globalThis.retained",
      });
      expect(restored.text).toContain("42");
      expect(restored.details.pageId).toBe(first.details.pageId);

      const active = service.execute(owner, {
        action: "evaluate",
        script: "new Promise(resolve => setTimeout(() => resolve(43), 300))",
      });
      await service.expireIdleSession(
        owner,
        BROWSER_IDLE_RETENTION_MS,
        Date.now() + 2 * BROWSER_IDLE_RETENTION_MS,
      );
      expect((await active).text).toContain("43");
      expect(await service.hasSession(owner)).toBe(true);
      const usedAgain = await lastUsed();
      // Unrelated main/worker activity cannot extend this persisted browser idle clock.
      await service.dispose();
      service = new BrowserService(undefined, 4, root);
      await service.expireIdleSession(
        owner,
        BROWSER_IDLE_RETENTION_MS,
        usedAgain + BROWSER_IDLE_RETENTION_MS,
      );
      expect(await service.hasSession(owner)).toBe(false);
      // Restart Batty while the browser is stopped: disk profile alone survives.
      await service.dispose();
      service = new BrowserService(undefined, 4, root);
      const reopened = await service.execute(owner, { action: "open", url });
      expect(reopened.details.url).toBe(url);
      expect(
        (await service.execute(owner, { action: "evaluate", script: "globalThis.retained" })).text,
      ).toContain("undefined");
      const login = async () =>
        (
          await service.execute(owner, {
            action: "evaluate",
            script: '({cookie: document.cookie, storage: localStorage.getItem("login")})',
          })
        ).text;
      expect(await login()).toContain("login=retained");
      expect(await login()).toContain("storage: 'retained'");
      await service.execute(owner, { action: "close" });
      expect(await service.hasSession(owner)).toBe(false);
      await service.dispose();
      service = new BrowserService(undefined, 4, root);
      await service.execute(owner, { action: "open", url });
      expect(await login()).toContain("login=retained");
      expect(await login()).toContain("storage: 'retained'");
    } finally {
      await service.closeSession(owner);
      await service.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await removeBrowserIsolation(browserSessionDirectory(root, owner));
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);

test("browser service detach/reconnect preserves tabs, cookies, JavaScript state and tab/frame IDs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-browser-restart-"));
  const server = http.createServer((request, response) =>
    response.end(
      request.url === "/frame"
        ? "<html><body>Frame</body></html>"
        : '<html><body><h1>Persistent tab</h1><iframe src="/frame"></iframe></body></html>',
    ),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  let service = new BrowserService(undefined, 4, root);
  try {
    const first = await service.execute("durable", { action: "open", url });
    const pageId = first.details.pageId!;
    const beforeFrames = await service.execute("durable", { action: "frames", pageId });
    await service.execute("durable", {
      action: "evaluate",
      pageId,
      script:
        'globalThis.liveState = {counter: 42}; document.cookie = "durableCookie=present; Max-Age=3600; path=/"; "saved"',
    });
    const second = await service.execute("durable", { action: "open", url, newPage: true });
    await service.execute("durable", { action: "switch", pageId });
    await service.dispose();
    // Recover even if the original service died before saving its endpoint/PID
    // receipt: Chromium's profile lock and DevToolsActivePort are authoritative.
    const directory = browserSessionDirectory(root, "durable");
    await fs.rm(path.join(directory, "browser.json"));
    await fs.rm(path.join(directory, "process.json"));
    service = new BrowserService(undefined, 4, root);
    const pages = await service.execute("durable", { action: "pages" });
    expect(pages.details.pages?.map((page) => page.id).sort()).toEqual(
      [pageId, second.details.pageId!].sort(),
    );
    expect(pages.details.pages?.find((page) => page.active)?.id).toBe(pageId);
    const state = await service.execute("durable", {
      action: "evaluate",
      pageId,
      script: "({state: globalThis.liveState, cookies: document.cookie})",
    });
    expect(state.text).toContain("42");
    expect(state.text).toContain("durableCookie=present");
    const afterFrames = await service.execute("durable", { action: "frames", pageId });
    expect(afterFrames.details.frames?.map((frame) => frame.id)).toEqual(
      beforeFrames.details.frames?.map((frame) => frame.id),
    );
    const controller = new AbortController();
    const began = Date.now();
    const waiting = service.execute(
      "durable",
      { action: "evaluate", pageId, script: "new Promise(() => {})" },
      controller.signal,
    );
    const cancelled = waiting.then(
      () => "completed",
      () => "aborted",
    );
    setTimeout(() => controller.abort(new Error("cancelled")), 50);
    expect(await cancelled).toBe("aborted");
    expect(Date.now() - began).toBeLessThan(6000);
    expect(await service.hasSession("durable")).toBe(false);
    await expect(fs.stat(path.join(directory, "profile"))).resolves.toBeDefined();
    const disposing = Date.now();
    await service.dispose();
    expect(Date.now() - disposing).toBeLessThan(1000);
    service = new BrowserService(undefined, 4, root);
    const reopened = await service.execute("durable", { action: "open", url });
    const reopenedState = await service.execute("durable", {
      action: "evaluate",
      pageId: reopened.details.pageId,
      script: "({state: globalThis.liveState, cookies: document.cookie})",
    });
    expect(reopenedState.text).toContain("state: undefined");
    expect(reopenedState.text).toContain("durableCookie=present");
    const stuck = service
      .execute("durable", {
        action: "evaluate",
        pageId: reopened.details.pageId,
        script: "new Promise(() => {})",
      })
      .then(
        () => "completed",
        () => "closed",
      );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const closing = Date.now();
    await service.execute("durable", { action: "close" });
    expect(Date.now() - closing).toBeLessThan(6000);
    expect(await stuck).toBe("closed");
    expect(await service.hasSession("durable")).toBe(false);
    await expect(fs.stat(path.join(directory, "profile"))).resolves.toBeDefined();
    await expect(fs.stat(path.join(directory, "launch.json"))).rejects.toThrow("ENOENT");
  } finally {
    await service.closeSession("durable");
    await service.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await removeBrowserIsolation(browserSessionDirectory(root, "durable"));
    await fs.rm(root, { recursive: true, force: true });
  }
}, 30_000);
