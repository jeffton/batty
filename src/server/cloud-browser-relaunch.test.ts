// @vitest-environment node
import { expect, test, vi } from "vite-plus/test";
import fastify from "fastify";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { BrowserService } from "./browser-service";
import type { BrowserProxy } from "./ssh-socks-proxy";
import { registerCloudBrowserLauncher } from "./cloud-browser-launcher";
import {
  browserSessionDirectory,
  interruptedBrowser,
  readBrowserJson,
} from "./browser-persistence";
import { removeTestBrowserRoot } from "./test-browser-cleanup";

// Use a local fixture and isolated profile, never the shared workspace browser.
test.skipIf(process.platform !== "linux").each([false, true])(
  "viewer relaunch retains profile/tabs and reuses its live replacement (service restarted: %s)",
  async (restartService) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-cloud-relaunch-"));
    const website = http.createServer((_, response) =>
      response.end("<html><title>Relaunch fixture</title><body>Retained</body></html>"),
    );
    website.listen(0, "127.0.0.1");
    await once(website, "listening");
    const url = `http://127.0.0.1:${(website.address() as { port: number }).port}/`;
    let service = new BrowserService(undefined, 4, root);
    const owner = "workspace:fixture";
    const directory = browserSessionDirectory(root, owner);
    const app = fastify();
    registerCloudBrowserLauncher(
      app,
      { openCloudBrowser: (id: string) => service.openCloudBrowser(id) } as BrowserService,
      "https://batty.example",
      true,
      async () => ["fixture"],
    );
    const open = () =>
      app.inject({
        method: "POST",
        url: "/api/cloud-browser/open",
        headers: { origin: "https://batty.example" },
        payload: { workspaceId: "fixture" },
      });
    try {
      expect((await open()).statusCode).toBe(200);
      await service.execute(owner, { action: "open", url });
      await service.execute(owner, {
        action: "evaluate",
        script: 'localStorage.setItem("login", "retained"); globalThis.liveState = 42',
      });
      await service.execute(owner, { action: "open", url: `${url}second`, newPage: true });
      const before = await readBrowserJson<{ pid: number }>(path.join(directory, "browser.json"));
      const isolation = await fs.readFile(path.join(directory, "isolation.json"), "utf8");
      // A browser closed outside Batty leaves its process/display receipts behind.
      const attachment = await service.openCloudBrowser(owner);
      const target = await service.cloudTarget(attachment.browserId);
      const cdp = await target.page.context().browser()!.newBrowserCDPSession();
      await cdp.send("Browser.close");
      await expect.poll(() => interruptedBrowser(directory)).toBeDefined();
      if (restartService) {
        // Establish flushed profile/session data, then kill the replacement abruptly.
        expect((await open()).statusCode).toBe(200);
        const running = await readBrowserJson<{ pid: number }>(
          path.join(directory, "browser.json"),
        );
        process.kill(running!.pid, "SIGKILL");
        await expect.poll(() => interruptedBrowser(directory)).toBeDefined();
        await service.dispose();
        service = new BrowserService(undefined, 4, root);
      }
      // A routed session must not be relaunched directly if its proxy is unavailable.
      const receiptFile = path.join(directory, "browser.json");
      const receipt = JSON.parse(await fs.readFile(receiptFile, "utf8"));
      await fs.writeFile(receiptFile, JSON.stringify({ ...receipt, useTailscale: true }));
      const blocked = await open();
      expect(blocked.statusCode).toBe(500);
      expect(blocked.json().message).toContain("Tailscale browser routing is not configured");
      expect(await readBrowserJson(receiptFile)).toEqual({ ...receipt, useTailscale: true });
      await fs.writeFile(receiptFile, JSON.stringify(receipt));

      const response = await open();
      expect(response.statusCode, response.body).toBe(200);
      const replacement = response.json();
      const after = await readBrowserJson<{ pid: number }>(path.join(directory, "browser.json"));
      expect(after!.pid).not.toBe(before!.pid);
      expect(await fs.readFile(path.join(directory, "isolation.json"), "utf8")).toBe(isolation);
      const state = await service.cloudState(replacement.browserId);
      expect(state.pages.map((page) => page.url)).toEqual(
        expect.arrayContaining([url, `${url}second`]),
      );
      const restoredPage = state.pages.find((page) => page.url === url)!;
      await service.execute(owner, { action: "open", url, pageId: restoredPage.id });
      expect(
        (
          await service.execute(owner, {
            action: "evaluate",
            script: '({login: localStorage.getItem("login"), state: globalThis.liveState})',
          })
        ).text,
      ).toContain("login: 'retained'");
      const unchanged = await open();
      expect(unchanged.statusCode).toBe(200);
      expect(unchanged.json().browserId).toBe(replacement.browserId);
      expect(await readBrowserJson(path.join(directory, "browser.json"))).toEqual(after);
      await service.closeSession(owner);
      expect((await open()).statusCode).toBe(200);
    } finally {
      await app.close();
      await service.closeSession(owner);
      await service.dispose();
      website.closeAllConnections();
      await new Promise<void>((resolve) => website.close(() => resolve()));
      await removeTestBrowserRoot(root);
    }
  },
  30_000,
);

test.skipIf(process.platform !== "linux")(
  "failed relaunch retains saved proxy routing for the next viewer click",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-cloud-relaunch-routing-"));
    const owner = "workspace:routed";
    const directory = browserSessionDirectory(root, owner);
    await fs.mkdir(directory);
    await fs.writeFile(
      path.join(directory, "browser.json"),
      JSON.stringify({
        pid: 2147483647,
        endpoint: "ws://127.0.0.1:1",
        useTailscale: true,
      }),
    );
    await fs.writeFile(path.join(directory, "launch.json"), JSON.stringify({ useTailscale: true }));
    const ensureStarted = vi
      .fn()
      .mockResolvedValueOnce("socks5://127.0.0.1:1")
      .mockRejectedValueOnce(new Error("Proxy interrupted after preflight"))
      .mockResolvedValue("socks5://127.0.0.1:1");
    const proxy = { ensureStarted, dispose: vi.fn(async () => {}) } as unknown as BrowserProxy;
    const service = new BrowserService(proxy, 4, root);
    try {
      await expect(service.openCloudBrowser(owner)).rejects.toThrow(
        "Proxy interrupted after preflight",
      );
      expect(await readBrowserJson(path.join(directory, "browser.json"))).toBeUndefined();
      expect(await readBrowserJson(path.join(directory, "relaunch.json"))).toEqual({
        useTailscale: true,
      });
      await expect(
        service.execute(owner, { action: "open", url: "https://example.com" }),
      ).rejects.toThrow("Browser relaunch was interrupted");
      expect(await readBrowserJson(path.join(directory, "browser.json"))).toBeUndefined();
      const attachment = await service.openCloudBrowser(owner);
      expect(attachment.browserId).toBeDefined();
      expect(await readBrowserJson(path.join(directory, "browser.json"))).toMatchObject({
        useTailscale: true,
      });
      expect(await readBrowserJson(path.join(directory, "relaunch.json"))).toBeUndefined();
      const receipt = await readBrowserJson<{ pid: number }>(path.join(directory, "browser.json"));
      expect((await fs.readFile(`/proc/${receipt!.pid}/cmdline`, "utf8")).split("\0")).toContain(
        "--proxy-server=socks5://127.0.0.1:1",
      );
      await service.execute(owner, { action: "close" });
      await fs.writeFile(
        path.join(directory, "relaunch.json"),
        JSON.stringify({ useTailscale: true }),
      );
      await service.execute(owner, { action: "close" });
      expect(await readBrowserJson(path.join(directory, "relaunch.json"))).toBeUndefined();
    } finally {
      await service.closeSession(owner);
      await service.dispose();
      await removeTestBrowserRoot(root);
    }
  },
  30_000,
);
