import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = "/var/lib/batty-browser";
const USER = "batty-browser";

export interface BrowserIsolation {
  uid: number;
  gid: number;
  directory: string;
  executable: string;
}

/** Root keeps the control plane; Chromium receives only its own profile and X cookie. */
export async function prepareBrowserIsolation(
  directory: string,
  executable: string,
): Promise<BrowserIsolation | undefined> {
  if (process.platform !== "linux" || process.getuid?.() !== 0) return undefined;
  const id = async (flag: string) =>
    Number((await promisify(execFile)("id", [flag, USER], { timeout: 5000 })).stdout.trim());
  const [uid, gid] = await Promise.all([id("-u"), id("-g")]);
  if (!uid || !gid) throw new Error("batty-browser must be an unprivileged account");
  const installed = path.join(
    "/opt/batty-browser",
    path.basename(path.dirname(path.dirname(executable))),
    path.basename(path.dirname(executable)),
    path.basename(executable),
  );
  await fs.access(installed, fs.constants.X_OK);
  const isolated = await fs.mkdtemp(path.join(ROOT, "sessions", "browser-"));
  await fs.chown(isolated, 0, gid);
  await fs.chmod(isolated, 0o710);
  const isolation = { uid, gid, directory: isolated, executable: installed };
  const artifacts = path.join(isolated, "artifacts");
  await fs.mkdir(artifacts, { mode: 0o700 });
  await fs.chown(artifacts, uid, gid);
  // Root-owned receipt: never derive cleanup paths from browser-controlled files.
  await fs.writeFile(path.join(directory, "isolation.json"), JSON.stringify(isolation), {
    mode: 0o600,
  });
  const profile = path.join(directory, "profile");
  const existing = await fs.lstat(profile).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (existing) {
    if (!existing.isDirectory() || existing.uid !== 0)
      throw new Error("New browser profile must be a root-owned directory");
    await fs.rename(profile, path.join(isolated, "profile"));
  } else {
    await fs.mkdir(path.join(isolated, "profile"), { mode: 0o700 });
  }
  await fs.symlink(path.join(isolated, "profile"), profile);
  return isolation;
}

/** Never signal a PID supplied only by a browser-writable profile lock. */
export async function ownsBrowserProcess(directory: string, pid: number): Promise<boolean> {
  if (process.platform !== "linux") return true;
  const command = await fs.readFile(`/proc/${pid}/cmdline`, "utf8").catch((error) => {
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code!)) return undefined;
    throw error;
  });
  if (!command) return false;
  const isolation = await fs
    .readFile(path.join(directory, "isolation.json"), "utf8")
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
  const profile = path.join(
    isolation ? (JSON.parse(isolation) as BrowserIsolation).directory : directory,
    "profile",
  );
  if (!command.split("\0").includes(`--user-data-dir=${profile}`))
    throw new Error(`Persistent browser PID ${pid} belongs to another process`);
  return true;
}

export async function assertBrowserIsolation(directory: string, pid: number): Promise<void> {
  if (process.platform !== "linux" || process.getuid?.() !== 0) return;
  const receipt = await fs
    .readFile(path.join(directory, "isolation.json"), "utf8")
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new Error("This browser predates UID isolation. Close and reopen it.");
      throw error;
    });
  const isolation: BrowserIsolation = JSON.parse(receipt);
  const status = await fs.stat(`/proc/${pid}`);
  if (!isolation.uid || status.uid !== isolation.uid)
    throw new Error("Persistent Chromium is not running under its isolated UID");
}

export async function enableBrowserProfile(isolation: BrowserIsolation): Promise<void> {
  // Preferences were initialized by root, before Chromium could write symlinks.
  const profile = path.join(isolation.directory, "profile");
  for (const entry of ["Default/Preferences", "Default", ""]) {
    await fs.chown(path.join(profile, entry), isolation.uid, isolation.gid);
  }
}

export async function removeBrowserIsolation(directory: string): Promise<void> {
  let isolation: BrowserIsolation;
  try {
    isolation = JSON.parse(await fs.readFile(path.join(directory, "isolation.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await fs.rm(isolation.directory, { recursive: true, force: true });
  const profile = path.join(directory, "profile");
  const link = await fs.lstat(profile).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (link?.isSymbolicLink()) await fs.rm(profile);
  await fs.rm(path.join(directory, "isolation.json"));
}

export function isolatedBrowserEnvironment(isolation: BrowserIsolation): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    HOME: "/var/lib/batty-browser/home",
    LANG: "en_US.UTF-8",
    // Do not inherit provider credentials, loader flags or the root service environment.
    XDG_CACHE_HOME: path.join(isolation.directory, "profile", "cache"),
    XDG_CONFIG_HOME: path.join(isolation.directory, "profile", "config"),
  };
}
