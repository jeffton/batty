import type { ChildProcess } from "node:child_process";
import {
  browserAdmin,
  browserDescendantPid,
  browserSignal,
  spawnBrowserProcess,
} from "./browser-privilege";
import { readBrowserProfileFile } from "./browser-profile";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Browser, BrowserType } from "patchright";
import {
  isolatedBrowserEnvironment,
  prepareBrowserIsolation,
  removeBrowserIsolation,
  ownsBrowserProcess,
  assertBrowserIsolation,
} from "./browser-isolation";
import { stopBrowserChild } from "./browser-process";

/** Separate ephemeral extraction browser; never attaches to a user's cloud profile. */
export async function launchHeadlessBrowser(
  chromium: BrowserType,
  executable: string,
  args: string[],
): Promise<Browser> {
  if (process.platform !== "linux") {
    return chromium.launch({
      headless: true,
      executablePath: executable,
      chromiumSandbox: true,
      args,
    });
  }

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "batty-headless-"));
  let child: ChildProcess | undefined;
  let browserPid: number | undefined;
  let isolatedExecutable: string | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () =>
    (cleanupPromise ??= (async () => {
      if (child?.pid) {
        // Chrome can leave writers alive after its main process exits. This launch
        // owns a separate process group; end that group before deleting its profile.
        try {
          if (isolatedExecutable)
            browserPid ??= await browserDescendantPid(child.pid, isolatedExecutable);
          if (browserPid && (await ownsBrowserProcess(directory, browserPid))) {
            await assertBrowserIsolation(directory, browserPid);
            await browserSignal(-browserPid, "SIGKILL");
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
        await stopBrowserChild(child);
      }
      await removeBrowserIsolation(directory);
      await fs.rm(directory, { recursive: true, force: true });
    })());
  try {
    const isolation = (await prepareBrowserIsolation(directory, executable))!;
    isolatedExecutable = isolation.executable;
    const profile = path.join(isolation.directory, "profile");
    await browserAdmin("/usr/bin/chown", [`${isolation.uid}:${isolation.gid}`, profile]);
    const logPath = path.join(directory, "chromium.log");
    const log = await fs.open(logPath, "wx", 0o600);
    try {
      child = spawnBrowserProcess(
        "/usr/bin/setpriv",
        [
          `--reuid=${isolation.uid}`,
          `--regid=${isolation.gid}`,
          "--clear-groups",
          "--no-new-privs",
          "--",
          isolation.executable,
          "--headless=new",
          "--disable-blink-features=AutomationControlled",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-background-networking",
          "--disable-component-update",
          "--remote-debugging-address=127.0.0.1",
          "--remote-debugging-port=0",
          `--user-data-dir=${profile}`,
          ...args,
          "about:blank",
        ],
        {
          detached: true,
          cwd: "/",
          env: isolatedBrowserEnvironment(isolation),
          stdio: ["ignore", log.fd, log.fd],
        },
      );
      await new Promise<void>((resolve, reject) => {
        child!.once("spawn", resolve);
        child!.once("error", reject);
      });
    } finally {
      await log.close();
    }
    const deadline = Date.now() + 30_000;
    let endpoint: string | undefined;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`Headless Chromium exited: ${await fs.readFile(logPath, "utf8")}`);
      browserPid ??= await browserDescendantPid(child.pid!, isolation.executable);
      const port = await readBrowserProfileFile(directory, "DevToolsActivePort");
      if (port && browserPid) {
        await assertBrowserIsolation(directory, browserPid);
        const [number, browserPath] = port.trim().split("\n");
        endpoint = `ws://127.0.0.1:${number}${browserPath}`;
        break;
      }
      await delay(50);
    }
    if (!endpoint) throw new Error("Headless Chromium did not expose CDP within 30 seconds");
    const browser = await chromium.connectOverCDP(endpoint, {
      timeout: 30_000,
      artifactsDir: path.join(isolation.directory, "artifacts"),
    });
    // CDP Browser.close() disconnects without terminating an externally spawned Chrome.
    // Preserve the shared runtime's close contract, including process/profile cleanup.
    const disconnect = browser.close.bind(browser);
    let closing: Promise<void> | undefined;
    browser.close = (options) =>
      (closing ??= (async () => {
        try {
          if (browser.isConnected()) {
            const cdp = await browser.newBrowserCDPSession();
            await cdp.send("Browser.close");
          }
          await disconnect(options);
        } finally {
          await cleanup();
        }
      })());
    browser.on("disconnected", () => {
      if (!closing)
        void cleanup().catch((error) => console.error("Headless browser cleanup failed", error));
    });
    return browser;
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Headless browser launch and cleanup failed");
    }
    throw error;
  }
}
