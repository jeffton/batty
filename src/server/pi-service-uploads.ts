import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import mime from "mime-types";
import type { UploadedFile } from "./pi-service-types";

export interface UploadedPromptImage {
  name: string;
  storedName: string;
  batchId: string;
  mimeType: string;
  size: number;
  data: string;
  url: string;
}
export interface PreparedPromptFiles {
  text: string;
  images: Array<{ type: "image"; mimeType: string; data: string }>;
  uploadedImages: UploadedPromptImage[];
}

function sanitizeFileName(name: string): string {
  const sanitized = path.basename(name).replace(/[^a-zA-Z0-9._-]+/g, "-");
  return sanitized.length > 0 ? sanitized : "attachment.bin";
}
function uniqueStoredName(name: string, usedNames: Set<string>): string {
  const extension = path.extname(name);
  const stem = name.slice(0, name.length - extension.length);
  let candidate = name;
  let suffix = 2;
  while (usedNames.has(candidate.toLowerCase())) candidate = `${stem}-${suffix++}${extension}`;
  usedNames.add(candidate.toLowerCase());
  return candidate;
}
function escapeXmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
function uploadUrl(
  baseUrl: string | undefined,
  sessionId: string,
  batchId: string,
  storedName: string,
): string {
  const route = `/api/uploads/${[sessionId, batchId, storedName].map(encodeURIComponent).join("/")}`;
  const base =
    !baseUrl || baseUrl === "/" ? "" : `/${baseUrl.replace(/^\/+/, "").replace(/\/+$/, "")}`;
  return `${base}${route}`;
}

export async function preparePromptFiles(
  uploadsDir: string,
  sessionId: string,
  files: UploadedFile[],
  baseUrl?: string,
): Promise<PreparedPromptFiles> {
  const result: PreparedPromptFiles = { text: "", images: [], uploadedImages: [] };
  if (files.length === 0) return result;
  const batchId = randomUUID();
  const sessionDir = path.join(uploadsDir, sessionId, batchId);
  await fs.mkdir(sessionDir, { recursive: true });
  const usedNames = new Set<string>();
  for (const file of files) {
    const name = sanitizeFileName(file.filename || "attachment.bin");
    const storedName = uniqueStoredName(name, usedNames);
    const filePath = path.join(sessionDir, storedName);
    await fs.writeFile(filePath, file.data);
    const mimeType = mime.lookup(storedName) || "application/octet-stream";
    const size = file.data.length;
    const url = uploadUrl(baseUrl, sessionId, batchId, storedName);
    if (mimeType.startsWith("image/")) {
      const data = file.data.toString("base64");
      result.images.push({ type: "image", mimeType, data });
      result.uploadedImages.push({ name, storedName, batchId, mimeType, size, data, url });
    }
    result.text += `<file name="${escapeXmlAttribute(name)}" mimeType="${escapeXmlAttribute(mimeType)}" size="${size}" path="${escapeXmlAttribute(filePath)}" url="${escapeXmlAttribute(url)}"></file>\n`;
  }
  return result;
}

/** Externalize the UI projection only. Harness messages and queued image payloads stay immutable. */
export function createUiImageResolver(
  uploadsDir: string,
  sessionId: string,
  baseUrl?: string,
): (image: { mimeType: string; data: string }) => { url: string; name: string } {
  const resolvedByData = new Map<string, { url: string; name: string }>();
  return ({ mimeType, data }) => {
    const cached = resolvedByData.get(data);
    if (cached) return cached;
    const hash = createHash("sha256").update(data).digest("hex");
    const extension = mimeType.split("/")[1]?.replace(/[^a-zA-Z0-9]+/g, "-") || "bin";
    const name = `${hash}.${extension}`;
    const directory = path.join(uploadsDir, sessionId, "imported");
    fsSync.mkdirSync(directory, { recursive: true });
    const filePath = path.join(directory, name);
    if (!fsSync.existsSync(filePath)) fsSync.writeFileSync(filePath, Buffer.from(data, "base64"));
    const resolved = { name, url: uploadUrl(baseUrl, sessionId, "imported", name) };
    resolvedByData.set(data, resolved);
    return resolved;
  };
}

export async function resolveUploadedFile(
  uploadsDir: string,
  sessionId: string,
  batchId: string,
  storedName: string,
): Promise<{ path: string; mimeType: string }> {
  const filePath = path.join(uploadsDir, sessionId, batchId, sanitizeFileName(storedName));
  const relative = path.relative(uploadsDir, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw Object.assign(new Error("Invalid uploaded file path"), { statusCode: 400 });
  await fs.access(filePath);
  return { path: filePath, mimeType: mime.lookup(filePath) || "application/octet-stream" };
}
