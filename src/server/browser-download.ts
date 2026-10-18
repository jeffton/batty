import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { stopBrowserChild } from "./browser-process";
import type { BrowserIsolation } from "./browser-isolation";

/** Read browser-controlled artifacts as their UID, never as the root service. */
export async function copyIsolatedBrowserDownload(
  source: string,
  destination: string,
  isolation: BrowserIsolation,
): Promise<void> {
  // The output stays in a root-only directory. The child receives a write-only
  // descriptor, not traversal permission or ownership of the returned file.
  const output = await fs.open(destination, "wx", 0o600);
  const child = spawn(
    "/usr/bin/setpriv",
    [
      `--reuid=${isolation.uid}`,
      `--regid=${isolation.gid}`,
      "--clear-groups",
      "--no-new-privs",
      "--",
      "/bin/cat",
      "--",
      source,
    ],
    {
      cwd: "/",
      env: { PATH: "/usr/bin:/bin", LANG: "C" },
      stdio: ["ignore", output.fd, "pipe"],
    },
  );
  let stderr = "";
  child.stderr!.on("data", (data: Buffer) => {
    stderr = (stderr + data.toString()).slice(-4000);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Browser download extraction timed out")),
        15_000,
      );
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`Browser download extraction failed: ${stderr}`));
      });
    });
  } catch (error) {
    await stopBrowserChild(child);
    await fs.rm(destination, { force: true });
    throw error;
  } finally {
    await output.close();
  }
}
