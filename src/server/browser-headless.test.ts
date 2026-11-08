import { describe, expect, it, vi } from "vite-plus/test";
import fs from "node:fs/promises";
import http from "node:http";
import { once } from "node:events";
import type { BrowserType } from "patchright";
import { chromium } from "patchright";
import { browserAdmin } from "./browser-privilege";
import { browserExecutablePath } from "./browser-executable";
import { launchHeadlessBrowser } from "./browser-headless";
import { closeSharedBrowser, getSharedBrowser } from "./browser-runtime";

describe("shared headless browser protection", () => {
  it.skipIf(process.platform !== "linux")(
    "retains shared launch, close and relaunch semantics",
    async () => {
      try {
        const [a, b] = await Promise.all([getSharedBrowser(), getSharedBrowser()]);
        expect(a).toBe(b);
        await closeSharedBrowser();
        expect(a.isConnected()).toBe(false);
        const next = await getSharedBrowser();
        expect(next).not.toBe(a);
        expect(next.isConnected()).toBe(true);
      } finally {
        await closeSharedBrowser();
      }
    },
    45_000,
  );

  it.skipIf(process.platform !== "linux")(
    "terminates its child and removes its profile when CDP attachment fails",
    async () => {
      let pid: number | undefined;
      let profile: string | undefined;
      const failingChromium = {
        connectOverCDP: async (endpoint: string) => {
          const connected = await chromium.connectOverCDP(endpoint);
          try {
            const cdp = await connected.newBrowserCDPSession();
            const processes = await cdp.send("SystemInfo.getProcessInfo");
            pid = processes.processInfo.find((entry) => entry.type === "browser")!.id;
            const args = (await fs.readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
            profile = args
              .find((arg) => arg.startsWith("--user-data-dir="))!
              .slice("--user-data-dir=".length);
          } finally {
            await connected.close();
          }
          throw new Error("synthetic CDP attachment failure");
        },
      } as unknown as BrowserType;
      await expect(
        launchHeadlessBrowser(failingChromium, browserExecutablePath(), []),
      ).rejects.toThrow("synthetic CDP attachment failure");
      expect(pid).toBeDefined();
      expect(profile).toBeDefined();
      await expect(fs.stat(`/proc/${pid}`)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(profile!)).rejects.toMatchObject({ code: "ENOENT" });
    },
    45_000,
  );
  it.each(["win32", "darwin"])("explicitly enables the Chrome sandbox on %s", async (platform) => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    const uid = process.getuid && vi.spyOn(process, "getuid").mockReturnValue(1000);
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    try {
      const launch = vi.fn().mockResolvedValue({});
      await launchHeadlessBrowser({ launch } as unknown as BrowserType, "/chrome", ["--test-arg"]);
      expect(launch).toHaveBeenCalledWith({
        headless: true,
        executablePath: "/chrome",
        chromiumSandbox: true,
        args: ["--test-arg"],
      });
    } finally {
      Object.defineProperty(process, "platform", descriptor);
      uid?.mockRestore();
    }
  });

  it.skipIf(process.platform !== "linux")(
    "never launches Linux Chromium as the control-plane UID when isolation fails",
    async () => {
      const uid = vi.spyOn(process, "getuid").mockReturnValue(1000);
      const launch = vi.fn();
      try {
        await expect(
          launchHeadlessBrowser(
            { launch } as unknown as BrowserType,
            "/missing-chrome-fixture",
            [],
          ),
        ).rejects.toThrow();
        expect(launch).not.toHaveBeenCalled();
      } finally {
        uid.mockRestore();
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "drops control-plane credentials/environment, enables kernel sandboxing and cleans up on close",
    async () => {
      const server = http.createServer((_req, res) => res.end("<h1>Extraction fixture</h1>"));
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      // A synthetic sentinel proves that even innocently named service variables are not inherited.
      process.env.BATTY_HEADLESS_TEST_SENTINEL = "synthetic-not-a-secret";
      let browser;
      let pid: number | undefined;
      let profile: string | undefined;
      try {
        browser = await launchHeadlessBrowser(chromium, browserExecutablePath(), [
          "--disable-dev-shm-usage",
        ]);
        const cdp = await browser.newBrowserCDPSession();
        const processes = await cdp.send("SystemInfo.getProcessInfo");
        pid = processes.processInfo.find((entry) => entry.type === "browser")!.id;
        const status = await fs.readFile(`/proc/${pid}/status`, "utf8");
        expect(status).not.toMatch(/Uid:\s+0\s/);
        expect(status).not.toMatch(new RegExp(`Uid:\\s+${process.getuid!()}\\s`));
        expect(status).toMatch(/Groups:\s*\n/);
        expect(status).toMatch(/CapEff:\s+0+\n/);
        expect(status).toMatch(/NoNewPrivs:\s+1\n/);
        const env = await browserAdmin("/bin/cat", [`/proc/${pid}/environ`]);
        expect(env).not.toContain("BATTY_HEADLESS_TEST_SENTINEL");
        expect(env).toContain("HOME=/var/lib/batty-browser/home");
        const args = (await fs.readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
        expect(args).not.toContain("--no-sandbox");
        profile = args.find((arg) => arg.startsWith("--user-data-dir="))!.split("=")[1]!;
        expect(profile).toMatch(/^\/var\/lib\/batty-browser\/sessions\/browser-.*\/profile$/);
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto("chrome://sandbox");
        const sandbox = await page.locator("body").innerText();
        expect(sandbox).toMatch(/PID namespaces\s+Yes/);
        expect(sandbox).toMatch(/Network namespaces\s+Yes/);
        expect(sandbox).toMatch(/Seccomp-BPF sandbox\s+Yes/);
        expect(sandbox).toMatch(/adequately sandboxed/);
        await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
        expect(await page.locator("h1").innerText()).toBe("Extraction fixture");
        await context.close();
        await browser.close();
        await expect(fs.stat(`/proc/${pid}`)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.stat(profile)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        delete process.env.BATTY_HEADLESS_TEST_SENTINEL;
        await browser?.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    45_000,
  );
});
