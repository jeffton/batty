import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export function buildIdFromHtml(html: string): string {
  return createHash("sha1").update(html).digest("hex").slice(0, 12);
}

export async function readBuildId(publicDir: string): Promise<string> {
  try {
    const html = await fs.readFile(path.join(publicDir, "index.html"), "utf8");
    return buildIdFromHtml(html);
  } catch {
    return "dev";
  }
}
