import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Browser } from "patchright";
import type { CloudBrowserViewport } from "@/shared/cloud-browser";

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

export async function connectPersistentBrowser(
  directory: string,
  options?: { useTailscale: boolean; proxyServer?: string; userAgent?: string },
): Promise<{ browser: Browser; receipt: PersistentBrowserReceipt; created: boolean }> {
  const { chromium } = await import("patchright");
  let receipt = await readBrowserJson<PersistentBrowserReceipt>(
    path.join(directory, "browser.json"),
  );
  if (receipt) {
    // A dead browser is an explicit interruption, never silently replaced with
    // an empty profile/page. action=close lets the user clear the dead session.
    process.kill(receipt.pid, 0);
    const browser = await chromium.connectOverCDP(receipt.endpoint);
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
          browser: await chromium.connectOverCDP(receipt.endpoint),
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
  const args = [
    "--headless=new",
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
  const child = spawn(chromium.executablePath(), args, {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", log.fd, log.fd],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
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
      return { browser: await chromium.connectOverCDP(receipt.endpoint), receipt, created: true };
    }
    await delay(50);
  }
  await terminateBrowser(pid, "SIGKILL");
  throw new Error(`Persistent Chromium did not expose CDP within 30 seconds: ${directory}`);
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
  await browser?.close();
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
