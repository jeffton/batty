import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Browser } from "patchright";
import type { CloudBrowserViewport } from "@/shared/cloud-browser";
import { createBrowserDisplay, stopBrowserDisplay, type BrowserDisplay } from "./browser-display";
import { stopBrowserChild } from "./browser-process";
import { browserAbortable } from "./browser-abort";

async function profileBrowserPid(directory: string): Promise<number | undefined> {
  if (process.platform === "win32") {
    const { stdout } = await promisify(execFile)(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$pattern = [regex]::Escape('--user-data-dir=' + $env:BATTY_BROWSER_PROFILE) + '(?=\"|\\s|$)'; Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -and -not $_.CommandLine.Contains('--type=') -and $_.CommandLine -match $pattern } | ForEach-Object { $_.ProcessId }",
      ],
      {
        windowsHide: true,
        env: { ...process.env, BATTY_BROWSER_PROFILE: path.join(directory, "profile") },
      },
    );
    const pids = stdout.trim().split(/\s+/).filter(Boolean).map(Number);
    if (pids.length > 1) throw new Error(`Multiple Chromium owners for ${directory}`);
    return pids[0];
  }
  const lock = await fs
    .readlink(path.join(directory, "profile", "SingletonLock"))
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
  return lock ? Number(lock.slice(lock.lastIndexOf("-") + 1)) : undefined;
}

async function terminateBrowser(pid: number, signal: NodeJS.Signals): Promise<void> {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
  if (process.platform === "win32") {
    await promisify(execFile)("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
    });
  } else {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

export interface PersistentBrowserReceipt {
  pid: number;
  endpoint: string;
  useTailscale: boolean;
}
export interface PersistentBrowserRegistry {
  cloudViewport?: CloudBrowserViewport;
  activePageId?: string;
  nextPageNumber: number;
  nextFrameNumber: number;
  pages: Record<string, string>;
  frames: Record<string, string>;
}

export function browserSessionDirectory(root: string, sessionId: string): string {
  return path.join(root, createHash("sha256").update(sessionId).digest("hex"));
}
export async function readBrowserJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
export async function writeBrowserJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
  await fs.rename(`${file}.tmp`, file);
}

/** Resolve the live display owned by this persistent browser, without exposing its receipt. */
export async function persistentBrowserDisplay(
  directory: string,
): Promise<Pick<BrowserDisplay, "display" | "authority">> {
  const display = await readBrowserJson<BrowserDisplay>(path.join(directory, "display.json"));
  if (!display)
    throw Object.assign(
      new Error(
        "This browser predates native H.264 capture. The existing browser and login are unchanged; a new browser process is required.",
      ),
      { statusCode: 426 },
    );
  process.kill(display.pid, 0);
  return { display: display.display, authority: display.authority };
}

export async function connectPersistentBrowser(
  directory: string,
  options?: { useTailscale: boolean; proxyServer?: string; userAgent?: string },
  signal?: AbortSignal,
): Promise<{ browser: Browser; receipt: PersistentBrowserReceipt; created: boolean }> {
  signal?.throwIfAborted();
  const { chromium } = await import("patchright");
  const connect = async (endpoint: string) => {
    signal?.throwIfAborted();
    const pending = chromium.connectOverCDP(endpoint, { timeout: 30_000 });
    void pending.then(
      (browser) => {
        if (signal?.aborted) void browser.close().catch(() => {});
      },
      () => {},
    );
    return browserAbortable(pending, signal);
  };
  let receipt = await readBrowserJson<PersistentBrowserReceipt>(
    path.join(directory, "browser.json"),
  );
  if (receipt) {
    // A dead browser is an explicit interruption, never silently replaced with
    // an empty profile/page. action=close lets the user clear the dead session.
    process.kill(receipt.pid, 0);
    const browser = await connect(receipt.endpoint);
    return { browser, receipt, created: false };
  }
  const starting = await readBrowserJson<{ pid: number; useTailscale: boolean }>(
    path.join(directory, "process.json"),
  );
  const intent = await readBrowserJson<{ useTailscale: boolean }>(
    path.join(directory, "launch.json"),
  );
  if (starting || intent) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      let pid = starting?.pid;
      if (!pid) pid = await profileBrowserPid(directory);
      if (pid) process.kill(pid, 0);
      const port = await fs
        .readFile(path.join(directory, "profile", "DevToolsActivePort"), "utf8")
        .catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        });
      if (pid && port) {
        const [number, browserPath] = port.trim().split("\n");
        receipt = {
          pid,
          endpoint: `ws://127.0.0.1:${number}${browserPath}`,
          useTailscale: starting?.useTailscale ?? intent!.useTailscale,
        };
        await writeBrowserJson(path.join(directory, "process.json"), {
          pid,
          useTailscale: receipt.useTailscale,
        });
        await writeBrowserJson(path.join(directory, "browser.json"), receipt);
        return {
          browser: await connect(receipt.endpoint),
          receipt,
          created: false,
        };
      }
      await delay(50);
    }
    throw new Error(
      `Persistent browser startup was interrupted: ${directory}. Close the session to clear it.`,
    );
  }
  if (!options) throw new Error("No persistent browser session exists");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const profile = path.join(directory, "profile");
  await fs.mkdir(profile, { recursive: true, mode: 0o700 });
  // Chromium profile preferences, not command-line feature names: both native
  // bubbles obscure our streamed webpage. Write only before a new process owns
  // the profile; never race Chrome's preference writer in an active session.
  const preferencesFile = path.join(profile, "Default", "Preferences");
  const preferences =
    (await readBrowserJson<Record<string, unknown> & { translate?: Record<string, unknown> }>(
      preferencesFile,
    )) ?? {};
  await writeBrowserJson(preferencesFile, {
    ...preferences,
    credentials_enable_service: false,
    translate: { ...preferences.translate, enabled: false },
  });
  let display: BrowserDisplay | undefined;
  let child: ChildProcess | undefined;
  try {
    if (process.platform === "linux") {
      display = await createBrowserDisplay(directory, signal);
      signal?.throwIfAborted();
      await writeBrowserJson(path.join(directory, "display.json"), display);
    }
    const args = [
      ...(display ? ["--kiosk", "--app=about:blank", "--window-position=0,0"] : ["--headless=new"]),
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-quic",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--window-size=1365,768",
      "--force-device-scale-factor=3",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-infobars",
      "--lang=en-US",
      ...(options.userAgent ? [`--user-agent=${options.userAgent}`] : []),
      ...(options.proxyServer
        ? [`--proxy-server=${options.proxyServer}`, "--proxy-bypass-list=<-loopback>"]
        : []),
      "about:blank",
    ];
    await writeBrowserJson(path.join(directory, "launch.json"), {
      useTailscale: options.useTailscale,
    });
    const log = await fs.open(path.join(directory, "chromium.log"), "a", 0o600);
    try {
      signal?.throwIfAborted();
      child = spawn(chromium.executablePath(), args, {
        detached: true,
        env: display
          ? { ...process.env, DISPLAY: display.display, XAUTHORITY: display.authority }
          : process.env,
        windowsHide: true,
        stdio: ["ignore", log.fd, log.fd],
      });
      await new Promise<void>((resolve, reject) => {
        child!.once("spawn", resolve);
        child!.once("error", reject);
      });
    } finally {
      await log.close();
    }
    child.unref();
    const pid = child.pid!;
    await writeBrowserJson(path.join(directory, "process.json"), {
      pid,
      useTailscale: options.useTailscale,
    });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(
          `Persistent Chromium exited: ${await fs.readFile(path.join(directory, "chromium.log"), "utf8")}`,
        );
      const portFile = await fs
        .readFile(path.join(profile, "DevToolsActivePort"), "utf8")
        .catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        });
      if (portFile) {
        const [port, browserPath] = portFile.trim().split("\n");
        receipt = {
          pid,
          endpoint: `ws://127.0.0.1:${port}${browserPath}`,
          useTailscale: options.useTailscale,
        };
        await writeBrowserJson(path.join(directory, "browser.json"), receipt);
        return { browser: await connect(receipt.endpoint), receipt, created: true };
      }
      await delay(50);
    }
    throw new Error(`Persistent Chromium did not expose CDP within 30 seconds: ${directory}`);
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try {
      if (child?.pid) {
        await terminateBrowser(child.pid, "SIGKILL");
        await stopBrowserChild(child);
      }
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      if (display) await stopBrowserDisplay(display);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length)
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Persistent browser launch and cleanup failed",
      );
    for (const name of [
      "launch.json",
      "process.json",
      "browser.json",
      "display.json",
      "profile/DevToolsActivePort",
    ])
      await fs.rm(path.join(directory, name), { force: true });
    throw error;
  }
}

export async function closePersistentBrowser(directory: string, browser?: Browser): Promise<void> {
  let receipt = await readBrowserJson<{ pid: number }>(path.join(directory, "process.json"));
  if (!receipt) {
    const pid = await profileBrowserPid(directory);
    if (pid) receipt = { pid };
  }
  if (receipt) {
    await terminateBrowser(receipt.pid, "SIGTERM");
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        process.kill(receipt.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") break;
        throw error;
      }
      await delay(50);
    }
    await terminateBrowser(receipt.pid, "SIGKILL");
  }
  const errors: unknown[] = [];
  try {
    if (browser) await browserAbortable(browser.close(), AbortSignal.timeout(2000));
  } catch (error) {
    errors.push(error);
  }
  let displayStopped = true;
  try {
    const display = await readBrowserJson<BrowserDisplay>(path.join(directory, "display.json"));
    if (display) await stopBrowserDisplay(display);
  } catch (error) {
    displayStopped = false;
    errors.push(error);
  }
  // The Chromium process is already terminated. A failed CDP disconnect must not
  // retain dead launch receipts; failed display cleanup must retain its ownership.
  if (displayStopped)
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  if (errors.length) throw new AggregateError(errors, "Persistent browser cleanup failed");
}
