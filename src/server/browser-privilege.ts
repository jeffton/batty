import { execFile, spawn, type SpawnOptions, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import {
  BROWSER_OWNER_SUPERVISOR,
  browserOwnerOptions,
  retainBrowserOwner,
  spawnOwnedProcess,
} from "./browser-owner";

/** The control plane may administer the browser, but Chromium never inherits its UID or env. */
export async function browserAdmin(command: string, args: string[]): Promise<string> {
  const elevated = process.getuid?.() !== 0;
  const result = await promisify(execFile)(
    elevated ? "/usr/bin/sudo" : command,
    elevated ? ["-n", "--", command, ...args] : args,
    { timeout: 15_000 },
  );
  return result.stdout.trim();
}

export function spawnBrowserProcess(
  command: string,
  args: string[],
  options: SpawnOptions,
  ephemeral = false,
): ChildProcess {
  const owned =
    process.platform === "linux" &&
    (ephemeral || process.env.VITEST === "true" || process.env.BATTY_EPHEMERAL_BROWSER === "1");
  if (process.platform !== "linux" || process.getuid?.() === 0)
    return owned ? spawnOwnedProcess(command, args, options) : spawn(command, args, options);
  // setsid gives the actual application its own process group, independently of sudo's monitor.
  const child = spawn(
    "/usr/bin/sudo",
    [
      "-n",
      "--",
      "/usr/bin/env",
      "-i",
      ...Object.entries(options.env ?? {})
        .filter((entry): entry is [string, string] => entry[1] !== undefined)
        .map(([key, value]) => `${key}=${value}`),
      ...(owned
        ? [process.execPath, "-e", BROWSER_OWNER_SUPERVISOR]
        : ["/usr/bin/setsid", "--wait"]),
      command,
      ...args,
    ],
    owned ? browserOwnerOptions(options) : options,
  );
  return owned ? retainBrowserOwner(child) : child;
}

export async function browserSignal(pid: number, signal: NodeJS.Signals | 0): Promise<void> {
  if (process.platform !== "linux" || process.getuid?.() === 0) {
    process.kill(pid, signal);
    return;
  }
  // Existence checks do not require permission to send a signal.
  if (signal === 0) {
    try {
      await fs.stat(`/proc/${Math.abs(pid)}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw Object.assign(new Error("Browser process no longer exists"), { code: "ESRCH" });
      throw error;
    }
    return;
  }
  try {
    await browserAdmin("/bin/kill", ["-s", signal, "--", String(pid)]);
  } catch (error) {
    // Preserve the same disappeared-process contract as process.kill.
    await browserSignal(Math.abs(pid), 0);
    throw error;
  }
}

/** sudo can retain a monitor PID; persisted receipts always refer to the real application. */
export async function browserDescendantPid(
  parent: number,
  executable: string,
): Promise<number | undefined> {
  const visit = async (pid: number): Promise<number | undefined> => {
    try {
      const args = (await fs.readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
      if (args[0] === executable) return pid;
      const children = await fs.readFile(`/proc/${pid}/task/${pid}/children`, "utf8");
      for (const child of children.trim().split(/\s+/).filter(Boolean)) {
        const found = await visit(Number(child));
        if (found) return found;
      }
    } catch (error) {
      if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code!)) throw error;
    }
    return undefined;
  };
  return visit(parent);
}
