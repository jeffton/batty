import { createHash } from "node:crypto";

export function buildIdFromHtml(html: string): string {
  return createHash("sha1").update(html).digest("hex").slice(0, 12);
}
