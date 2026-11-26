import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import mime from "mime-types";
import { fileArtifactRef } from "@/shared/artifacts";
import type { SentFileDescriptor } from "@/shared/types";
import { missingFile, storageDirectories, storageEntries } from "./artifact-storage";
import { prepareProviderImage } from "./provider-images";
export interface UploadedFile {
  filename: string;
  mimetype?: string;
  data: Buffer;
}

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

function uploadedFileId(sessionId: string, batchId: string, name: string) {
  return createHash("sha256")
    .update(JSON.stringify([sessionId, batchId, name]))
    .digest("hex");
}

function uploadedFileDescriptor(
  id: string,
  baseUrl: string,
  sessionId: string,
  batchId: string,
  name: string,
  size: number,
): SentFileDescriptor {
  const url = uploadUrl(baseUrl, sessionId, batchId, name);
  const mimeType = mime.lookup(name) || "application/octet-stream";
  const kind = mimeType.startsWith("image/")
    ? "image"
    : mimeType.startsWith("video/")
      ? "video"
      : "file";
  return {
    id,
    name,
    size,
    mimeType,
    kind,
    downloadUrl: `${url}?download=1`,
    ...(kind === "file" ? {} : { previewUrl: url }),
  };
}

export function uploadedPreviewPath(uploadsDir: string, filePath: string) {
  const id = createHash("sha256").update(path.relative(uploadsDir, filePath)).digest("hex");
  return path.join(uploadsDir, ".previews", `${id}.webp`);
}

export async function* storedUploadedFiles(uploadsDir: string, baseUrl: string, fileId: string) {
  for (const session of await storageDirectories(uploadsDir)) {
    const sessionId = path.basename(session);
    if (sessionId.startsWith(".")) continue;
    for (const batch of await storageDirectories(session)) {
      const batchId = path.basename(batch);
      if (batchId.startsWith(".")) continue;
      for (const entry of await storageEntries(batch)) {
        if (!entry.isFile()) continue;
        const { name } = entry;
        const id = uploadedFileId(sessionId, batchId, name);
        if (id !== fileId) continue;
        try {
          const storedPath = path.join(batch, name);
          const stats = await fs.stat(storedPath);
          yield {
            storedPath,
            file: uploadedFileDescriptor(id, baseUrl, sessionId, batchId, name, stats.size),
          };
        } catch (error) {
          if (!missingFile(error)) throw error;
        }
      }
    }
  }
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
  const sessionDir = path.join(uploadsDir, sessionId);
  const batchDir = path.join(sessionDir, batchId);
  const staging = path.join(sessionDir, `.${batchId}`);
  await fs.mkdir(staging, { recursive: true });
  try {
    await writePromptBatch(result, files, staging, batchDir, sessionId, batchId, baseUrl);
    await fs.rename(staging, batchDir);
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
  return result;
}

async function writePromptBatch(
  result: PreparedPromptFiles,
  files: UploadedFile[],
  staging: string,
  batchDir: string,
  sessionId: string,
  batchId: string,
  baseUrl?: string,
) {
  const usedNames = new Set<string>();
  for (const file of files) {
    const name = sanitizeFileName(file.filename || "attachment.bin");
    const storedName = uniqueStoredName(name, usedNames);
    const filePath = path.join(batchDir, storedName);
    await fs.writeFile(path.join(staging, storedName), file.data);
    const mimeType = mime.lookup(storedName) || "application/octet-stream";
    const size = file.data.length;
    const url = uploadUrl(baseUrl, sessionId, batchId, storedName);
    if (mimeType.startsWith("image/")) {
      const data = file.data.toString("base64");
      result.images.push(await prepareProviderImage({ type: "image", mimeType, data }));
      result.uploadedImages.push({ name, storedName, batchId, mimeType, size, data, url });
    }
    const artifactRef = fileArtifactRef(uploadedFileId(sessionId, batchId, storedName));
    result.text += `<file name="${escapeXmlAttribute(name)}" mimeType="${escapeXmlAttribute(mimeType)}" size="${size}" path="${escapeXmlAttribute(filePath)}" url="${escapeXmlAttribute(url)}" artifactRef="${artifactRef}"></file>\n`;
  }
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
