import fs from "node:fs/promises";
import path from "node:path";

export function withinWorkspace(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Walk names only, once per canonical directory (including hidden/untracked files). */
export async function* searchWorkspaceFileNames(
  root: string,
  name: string,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const needle = name.toLowerCase();
  const pending = [""];
  const visited = new Set<string>();
  while (pending.length) {
    signal.throwIfAborted();
    const relative = pending.pop()!;
    const canonical = await fs.realpath(path.join(root, relative));
    if (!withinWorkspace(root, canonical) || visited.has(canonical)) continue;
    visited.add(canonical);
    const directory = await fs.opendir(canonical);
    for await (const entry of directory) {
      signal.throwIfAborted();
      let relativePath = path.posix.join(relative, entry.name);
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        let target: string;
        try {
          target = await fs.realpath(path.join(canonical, entry.name));
        } catch (cause) {
          // Broken links have no file to open.
          if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw cause;
        }
        if (!withinWorkspace(root, target)) continue;
        const stat = await fs.stat(target);
        isDirectory = stat.isDirectory();
        isFile = stat.isFile();
        if (isDirectory) relativePath = path.relative(root, target).split(path.sep).join("/");
      }
      if (isDirectory) pending.push(relativePath);
      else if (isFile && entry.name.toLowerCase().includes(needle)) yield relativePath;
    }
  }
}
