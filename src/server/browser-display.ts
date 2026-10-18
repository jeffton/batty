import fs from "node:fs/promises";
import path from "node:path";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { stopBrowserChild } from "./browser-process";

export interface BrowserDisplay {
  pid: number;
  display: string;
  authority: string;
}
import { NATIVE_BROWSER_SIZE } from "@/shared/browser-geometry";
export { NATIVE_BROWSER_SCALE, NATIVE_BROWSER_SIZE } from "@/shared/browser-geometry";

function displayReady(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let pending = "";
    const finish = (error?: Error, display?: string) => {
      clearTimeout(timer);
      child.removeListener("error", failed);
      child.removeListener("exit", exited);
      child.stdout!.removeListener("data", data);
      if (error) reject(error);
      else resolve(display!);
    };
    const failed = (error: Error) => finish(error);
    const exited = (code: number | null) =>
      finish(new Error(`Private browser display exited (${code})`));
    const data = (chunk: Buffer) => {
      pending += chunk.toString();
      if (pending.includes("\n")) {
        if (!/^\d+\n$/.test(pending))
          finish(new Error("Private browser display returned an invalid display number"));
        else finish(undefined, `:${pending.trim()}`);
      } else if (pending.length > 16) {
        finish(new Error("Private browser display returned an invalid display number"));
      }
    };
    const timer = setTimeout(
      () => finish(new Error("Private browser display did not start")),
      10_000,
    );
    child.once("error", failed);
    child.once("exit", exited);
    child.stdout!.on("data", data);
  });
}

/** A session-private X server survives service restarts alongside persistent Chromium. */
export async function createBrowserDisplay(directory: string): Promise<BrowserDisplay> {
  const authority = path.join(directory, "Xauthority");
  await fs.writeFile(authority, "", { mode: 0o600 });
  const cookie = randomBytes(16).toString("hex");
  const auth = async (display: string) =>
    promisify(execFile)("xauth", ["-f", authority, "add", display, "MIT-MAGIC-COOKIE-1", cookie]);
  await auth(":0");
  const log = await fs.open(path.join(directory, "display.log"), "a", 0o600);
  let child: ChildProcess | undefined;
  try {
    child = spawn(
      "Xvfb",
      [
        "-displayfd",
        "1",
        "-screen",
        "0",
        `${NATIVE_BROWSER_SIZE}x${NATIVE_BROWSER_SIZE}x24`,
        "-nolisten",
        "tcp",
        "-auth",
        authority,
      ],
      { detached: true, stdio: ["ignore", "pipe", log.fd] },
    );
    const display = await displayReady(child);
    await auth(display);
    child.stdout!.destroy();
    child.unref();
    return { pid: child.pid!, display, authority };
  } catch (error) {
    if (child) await stopBrowserChild(child);
    throw error;
  } finally {
    await log.close();
  }
}

/** Verify the private X server's command before signalling a persisted PID. */
export async function stopBrowserDisplay(display: BrowserDisplay): Promise<void> {
  const ownsProcess = async () => {
    let args: string[];
    try {
      args = (await fs.readFile(`/proc/${display.pid}/cmdline`, "utf8")).split("\0");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ESRCH") return false;
      throw error;
    }
    if (!args[0]) return false;
    if (path.basename(args[0]) !== "Xvfb" || args[args.indexOf("-auth") + 1] !== display.authority)
      throw new Error(`Private browser display PID ${display.pid} belongs to another process`);
    return true;
  };
  const signal = (value: NodeJS.Signals) => {
    try {
      process.kill(display.pid, value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  if (!(await ownsProcess())) return;
  signal("SIGTERM");
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (!(await ownsProcess())) return;
    await delay(50);
  }
  if (await ownsProcess()) signal("SIGKILL");
}
