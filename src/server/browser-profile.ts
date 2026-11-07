import fs from "node:fs/promises";
import path from "node:path";
import { browserAdmin } from "./browser-privilege";

/** Read browser-controlled paths with only the browser's permissions, including symlink targets. */
export async function readBrowserProfileFile(
  directory: string,
  name: string,
  link = false,
): Promise<string | undefined> {
  if (process.platform !== "linux" || process.getuid?.() === 0) {
    try {
      return await (link
        ? fs.readlink(path.join(directory, "profile", name))
        : fs.readFile(path.join(directory, "profile", name), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  const receipt = await fs
    .readFile(path.join(directory, "isolation.json"), "utf8")
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
  if (!receipt) return undefined;
  const isolation = JSON.parse(receipt) as { directory: string };
  const file = path.join(isolation.directory, "profile", name);
  // Test absence as the same UID; do not hide permission errors or malformed state.
  const result = await browserAdmin("/usr/bin/sudo", [
    "-n",
    "-u",
    "batty-browser",
    "--",
    "/usr/bin/env",
    "-i",
    "PATH=/usr/bin:/bin",
    "/usr/bin/node",
    "-e",
    'const fs = require("node:fs"); try { process.stdout.write(process.argv[2] === "link" ? fs.readlinkSync(process.argv[1]) : fs.readFileSync(process.argv[1], "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }',
    file,
    link ? "link" : "file",
  ]);
  return result || undefined;
}
