import fs from "node:fs/promises";
import path from "node:path";
import { removeBrowserIsolation } from "./browser-isolation";

/** Remove only isolation profiles referenced by this stopped test fixture. */
export async function removeTestBrowserRoot(root: string): Promise<void> {
  const receipts: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await visit(path.join(directory, entry.name));
      else if (entry.isFile() && entry.name === "isolation.json") receipts.push(directory);
    }
  }
  await visit(root);
  for (const directory of receipts) await removeBrowserIsolation(directory);
  await fs.rm(root, { recursive: true, force: true });
}
