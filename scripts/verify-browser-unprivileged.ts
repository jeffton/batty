import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Browser, BrowserType } from "patchright";
import { chromium } from "patchright";
import { browserExecutablePath } from "../src/server/browser-executable";
import { launchHeadlessBrowser } from "../src/server/browser-headless";
import { closeSharedBrowser, getSharedBrowser } from "../src/server/browser-runtime";
import { browserAdmin } from "../src/server/browser-privilege";
import { connectPersistentBrowser } from "../src/server/browser-persistence";
import { removeBrowserIsolation } from "../src/server/browser-isolation";

assert.equal(process.platform, "linux");
assert.notEqual(process.getuid!(), 0, "Run this fixture as the non-root service user");

async function inspect(browser: Browser): Promise<{ pid: number; profile: string }> {
  const cdp = await browser.newBrowserCDPSession();
  const info = await cdp.send("SystemInfo.getProcessInfo");
  const pid = info.processInfo.find((entry) => entry.type === "browser")!.id;
  const status = await fs.readFile(`/proc/${pid}/status`, "utf8");
  assert(!status.includes(`Uid:\t${process.getuid!()}\t`));
  assert.match(status, /Groups:\s*\n/);
  assert.match(status, /CapEff:\s+0+\n/);
  assert.match(status, /NoNewPrivs:\s+1\n/);
  const args = (await fs.readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
  assert(!args.includes("--no-sandbox"));
  const profile = args
    .find((arg) => arg.startsWith("--user-data-dir="))!
    .slice("--user-data-dir=".length);
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto("chrome://sandbox");
    const sandbox = await page.locator("body").innerText();
    assert.match(sandbox, /PID namespaces\s+Yes/);
    assert.match(sandbox, /Network namespaces\s+Yes/);
    assert.match(sandbox, /Seccomp-BPF sandbox\s+Yes/);
    await page.goto("data:text/html,<h1>Unprivileged fixture</h1>");
    assert.equal(await page.locator("h1").innerText(), "Unprivileged fixture");
  } finally {
    await context.close();
  }
  return { pid, profile };
}

try {
  const [first, same] = await Promise.all([getSharedBrowser(), getSharedBrowser()]);
  assert.equal(first, same);
  const original = await inspect(first);
  // A browser-writable lock is never authority to signal the control-plane PID.
  await browserAdmin("/usr/bin/sudo", [
    "-n",
    "-u",
    "batty-browser",
    "--",
    "/usr/bin/ln",
    "-sfn",
    `${os.hostname()}-${process.pid}`,
    `${original.profile}/SingletonLock`,
  ]);
  await closeSharedBrowser();
  assert.throws(() => process.kill(original.pid, 0), { code: "ESRCH" });
  process.kill(process.pid, 0);
  await assert.rejects(fs.stat(original.profile), { code: "ENOENT" });
  const next = await getSharedBrowser();
  assert.notEqual(next, first);
  await inspect(next);
  await closeSharedBrowser();

  let failed: { pid: number; profile: string } | undefined;
  const failing = {
    connectOverCDP: async (endpoint: string) => {
      const browser = await chromium.connectOverCDP(endpoint);
      try {
        failed = await inspect(browser);
      } finally {
        await browser.close();
      }
      throw new Error("synthetic attachment failure");
    },
  } as unknown as BrowserType;
  await assert.rejects(
    launchHeadlessBrowser(failing, browserExecutablePath(), []),
    /synthetic attachment failure/,
  );
  assert(failed);
  assert.throws(() => process.kill(failed.pid, 0), { code: "ESRCH" });
  await assert.rejects(fs.stat(failed.profile), { code: "ENOENT" });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "batty-roy-launch-failure-"));
  const connect = chromium.connectOverCDP.bind(chromium);
  let persistent: { pid: number; profile: string } | undefined;
  chromium.connectOverCDP = async (...args) => {
    const browser = await connect(...args);
    try {
      persistent = await inspect(browser);
      await browserAdmin("/usr/bin/sudo", [
        "-n",
        "-u",
        "batty-browser",
        "--",
        "/usr/bin/ln",
        "-sfn",
        `${os.hostname()}-${process.pid}`,
        `${persistent.profile}/SingletonLock`,
      ]);
    } finally {
      await browser.close();
    }
    throw new Error("synthetic persistent attachment failure");
  };
  try {
    await assert.rejects(
      connectPersistentBrowser(directory, { useTailscale: false }),
      /synthetic persistent attachment failure/,
    );
    assert(persistent);
    assert.throws(() => process.kill(persistent.pid, 0), { code: "ESRCH" });
    process.kill(process.pid, 0);
  } finally {
    chromium.connectOverCDP = connect;
    await removeBrowserIsolation(directory);
    await fs.rm(directory, { recursive: true, force: true });
  }
  console.log(
    JSON.stringify({
      controlUid: process.getuid!(),
      sharedReuse: "passed",
      closeRelaunch: "passed",
      forgedLock: "passed",
      attachmentFailureCleanup: "passed",
      persistentForgedLockCleanup: "passed",
    }),
  );
} finally {
  await closeSharedBrowser();
}
