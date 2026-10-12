import { spawn } from "node:child_process";
import fs from "node:fs/promises";

// FileShare.None and flock are kernel lifetime locks, released when their holder exits.
const WINDOWS_HOLDER = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $file = [System.IO.File]::Open($env:BATTY_LOCK_PATH, 'OpenOrCreate', 'ReadWrite', 'None')
} catch [System.IO.IOException] { exit 1 }
try {
  [Console]::Out.Write('locked' + [char]10)
  [Console]::Out.Flush()
  [Console]::In.ReadToEnd() | Out-Null
} finally { $file.Dispose() }
`;
export async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
  const windows = process.platform === "win32";
  const holder = spawn(
    windows ? "powershell.exe" : "flock",
    windows
      ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_HOLDER]
      : ["--exclusive", "--nonblock", lockPath, "sh", "-c", "printf 'locked\\n'; cat >/dev/null"],
    {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, BATTY_LOCK_PATH: lockPath },
    },
  );
  let acquired = false;
  let releasing = false;
  const exited = new Promise<void>((resolve) => holder.once("exit", () => resolve()));
  await new Promise<void>((resolve, reject) => {
    let output = "";
    let errorOutput = "";
    holder.stdout.on("data", (data: Buffer) => {
      output += data.toString();
      if (output.includes("locked\n") && !acquired) {
        acquired = true;
        resolve();
      }
    });
    holder.stderr.on("data", (data: Buffer) => {
      errorOutput += data.toString();
    });
    holder.once("error", reject);
    holder.once("exit", (code) => {
      if (!acquired)
        reject(
          new Error(
            code === 1
              ? `Another Batty2 process owns ${lockPath}`
              : `Storage lock failed: ${errorOutput.trim()}`,
          ),
        );
      else if (!releasing) {
        console.error("Storage lock lost", lockPath);
        process.exit(1);
      }
    });
  });
  if (!windows) await fs.chmod(lockPath, 0o600);
  return async () => {
    releasing = true;
    holder.stdin.end();
    await exited;
  };
}
