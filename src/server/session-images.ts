import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import mime from "mime-types";

function canonicalSessionFile(filePath: string): string {
  const match = /^(.*\.sqlite)(?:\..*)?$/.exec(path.resolve(filePath));
  if (!match) throw new Error(`Invalid session storage path: ${filePath}`);
  return match[1]!;
}

export function sessionImageDirectory(sessionFile: string): string {
  return `${canonicalSessionFile(sessionFile)}.images`;
}

function imageName(bytes: Buffer, mimeType: string): string {
  const hash = createHash("sha256").update(bytes).digest("hex");
  const extension = mimeType.split("/")[1]?.replace(/[^a-zA-Z0-9]+/g, "-") || "bin";
  return `${hash}.${extension}`;
}

function imageRoute(
  baseUrl: string | undefined,
  workspaceId: string,
  sessionId: string,
  name: string,
): string {
  const route = `/api/session-images/${[workspaceId, sessionId, name]
    .map(encodeURIComponent)
    .join("/")}`;
  const base =
    !baseUrl || baseUrl === "/" ? "" : `/${baseUrl.replace(/^\/+/, "").replace(/\/+$/, "")}`;
  return `${base}${route}`;
}

/** Store UI-visible image data in the session-owned asset directory and return its route. */
export function createUiImageResolver(
  sessionFile: string,
  workspaceId: string,
  sessionId: string,
  baseUrl?: string,
): (image: { mimeType: string; data: string }) => { url: string; name: string } {
  const resolvedByData = new Map<string, { url: string; name: string }>();
  return ({ mimeType, data }) => {
    const cached = resolvedByData.get(data);
    if (cached) return cached;
    const bytes = Buffer.from(data, "base64");
    const name = imageName(bytes, mimeType);
    const directory = sessionImageDirectory(sessionFile);
    fsSync.mkdirSync(directory, { recursive: true });
    try {
      fsSync.writeFileSync(path.join(directory, name), bytes, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const resolved = { name, url: imageRoute(baseUrl, workspaceId, sessionId, name) };
    resolvedByData.set(data, resolved);
    return resolved;
  };
}

export async function resolveSessionImage(
  sessionFile: string,
  name: string,
): Promise<{ path: string; mimeType: string }> {
  if (path.basename(name) !== name) {
    throw Object.assign(new Error("Invalid session image path"), { statusCode: 400 });
  }
  const filePath = path.join(sessionImageDirectory(sessionFile), name);
  await fs.access(filePath);
  return { path: filePath, mimeType: mime.lookup(filePath) || "application/octet-stream" };
}
