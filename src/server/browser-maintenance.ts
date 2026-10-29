import fs from "node:fs/promises";
import path from "node:path";
import { acquireLock } from "./lock";
import { closePersistentBrowser } from "./browser-persistence";

/** Offline maintenance: exclude the live service and retain every browser profile. */
export async function closeBrowserProcesses(stateDirectory: string): Promise<number> {
  const unlock = await acquireLock(path.join(stateDirectory, "runtime.lock"));
  try {
    const root = path.join(stateDirectory, "browser");
    if (
      !(await fs.stat(root).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }))
    )
      return 0;
    const entries = await fs.readdir(root, { withFileTypes: true });
    let count = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      await closePersistentBrowser(path.join(root, entry.name));
      count++;
    }
    return count;
  } finally {
    await unlock();
  }
}
