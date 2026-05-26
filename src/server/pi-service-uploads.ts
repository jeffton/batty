import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import mime from "mime-types";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
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

interface BattyAttachment {
  kind: "image";
  name: string;
  mimeType: string;
  size: number;
  url: string;
}

const BATTY_ATTACHMENTS_PROPERTY = "battyAttachments";

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

function sanitizeFileName(name: string): string {
  const sanitized = path.basename(name).replace(/[^a-zA-Z0-9._-]+/g, "-");
  return sanitized.length > 0 ? sanitized : "attachment.bin";
}

function isImageMimeType(value: false | string): value is string {
  return typeof value === "string" && value.startsWith("image/");
}

function escapeXmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function formatUploadedFileReference(file: {
  name: string;
  mimeType: string;
  size: number;
  path: string;
  url: string;
}): string {
  return `<file name="${escapeXmlAttribute(file.name)}" mimeType="${escapeXmlAttribute(file.mimeType)}" size="${file.size}" path="${escapeXmlAttribute(file.path)}" url="${escapeXmlAttribute(file.url)}"></file>\n`;
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  if (!baseUrl || baseUrl === "/") {
    return "/";
  }
  return `/${baseUrl.replace(/^\/+/, "").replace(/\/+$/, "")}`;
}

function uploadUrl(
  baseUrl: string | undefined,
  sessionId: string,
  batchId: string,
  storedName: string,
): string {
  const route = `/api/uploads/${[sessionId, batchId, storedName].map(encodeURIComponent).join("/")}`;
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  return normalizedBaseUrl === "/" ? route : `${normalizedBaseUrl}${route}`;
}

async function processUploadedFiles(
  filePaths: string[],
  options: { baseUrl?: string; sessionId: string; batchId: string },
): Promise<PreparedPromptFiles> {
  let text = "";
  const images: PreparedPromptFiles["images"] = [];
  const uploadedImages: UploadedPromptImage[] = [];

  for (const filePath of filePaths) {
    const storedName = path.basename(filePath);
    const mimeType = mime.lookup(filePath) || "application/octet-stream";
    const stats = await fs.stat(filePath);
    const url = uploadUrl(options.baseUrl, options.sessionId, options.batchId, storedName);
    if (isImageMimeType(mimeType)) {
      const data = (await fs.readFile(filePath)).toString("base64");
      images.push({ type: "image", mimeType, data });
      uploadedImages.push({
        name: storedName,
        storedName,
        batchId: options.batchId,
        mimeType,
        size: stats.size,
        data,
        url,
      });
      text += formatUploadedFileReference({
        name: storedName,
        mimeType,
        size: stats.size,
        path: filePath,
        url,
      });
      continue;
    }

    text += formatUploadedFileReference({
      name: storedName,
      mimeType,
      size: stats.size,
      path: filePath,
      url,
    });
  }

  return { text, images, uploadedImages };
}

export async function preparePromptFiles(
  uploadsDir: string,
  sessionId: string,
  files: UploadedFile[],
  baseUrl?: string,
): Promise<PreparedPromptFiles> {
  if (files.length === 0) {
    return { text: "", images: [], uploadedImages: [] };
  }

  const batchId = randomUUID();
  const sessionDir = path.join(uploadsDir, sessionId, batchId);
  await ensureDir(sessionDir);

  const savedPaths: string[] = [];
  for (const file of files) {
    const targetPath = path.join(sessionDir, sanitizeFileName(file.filename || "attachment.bin"));
    await fs.writeFile(targetPath, file.data);
    savedPaths.push(targetPath);
  }

  return processUploadedFiles(savedPaths, { baseUrl, sessionId, batchId });
}

function externalizeContentImages(
  content: unknown,
  imagesByData: Map<string, UploadedPromptImage>,
): {
  content: unknown;
  attachments: BattyAttachment[];
  changed: boolean;
} {
  if (!Array.isArray(content)) {
    return { content, attachments: [], changed: false };
  }

  const attachments: BattyAttachment[] = [];
  let changed = false;
  const nextContent = content.flatMap((block) => {
    if (
      !block ||
      typeof block !== "object" ||
      (block as { type?: unknown }).type !== "image" ||
      typeof (block as { data?: unknown }).data !== "string"
    ) {
      return [block];
    }

    const uploaded = imagesByData.get((block as { data: string }).data);
    if (!uploaded) {
      return [block];
    }

    changed = true;
    attachments.push({
      kind: "image",
      name: uploaded.name,
      mimeType: uploaded.mimeType,
      size: uploaded.size,
      url: uploaded.url,
    });
    return [{ type: "text", text: `[Image attachment: ${uploaded.name}]` }];
  });

  return { content: nextContent, attachments, changed };
}

function externalizeMessageImages(
  message: unknown,
  imagesByData: Map<string, UploadedPromptImage>,
): boolean {
  if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "user") {
    return false;
  }

  const candidate = message as { content?: unknown; [BATTY_ATTACHMENTS_PROPERTY]?: unknown };
  const result = externalizeContentImages(candidate.content, imagesByData);
  if (!result.changed) {
    return false;
  }

  candidate.content = result.content;
  const existingAttachments = Array.isArray(candidate[BATTY_ATTACHMENTS_PROPERTY])
    ? candidate[BATTY_ATTACHMENTS_PROPERTY]
    : [];
  candidate[BATTY_ATTACHMENTS_PROPERTY] = [...existingAttachments, ...result.attachments];
  return true;
}

function externalizeImagesByData(
  session: AgentSession,
  imagesByData: Map<string, UploadedPromptImage>,
): void {
  let changed = false;

  for (const message of session.messages) {
    changed = externalizeMessageImages(message, imagesByData) || changed;
  }

  const manager = session.sessionManager as unknown as {
    fileEntries: Array<{ type?: unknown; message?: unknown }>;
    _rewriteFile: () => void;
  };
  for (const entry of manager.fileEntries) {
    if (entry.type === "message") {
      changed = externalizeMessageImages(entry.message, imagesByData) || changed;
    }
  }

  if (changed) {
    manager._rewriteFile();
  }
}

export function externalizeUploadedImagesInSession(
  session: AgentSession,
  uploadedImages: UploadedPromptImage[],
): void {
  if (uploadedImages.length === 0) {
    return;
  }

  externalizeImagesByData(session, new Map(uploadedImages.map((image) => [image.data, image])));
}

function uploadedImageFromInlineData(
  uploadsDir: string,
  baseUrl: string | undefined,
  sessionId: string,
  mimeType: string,
  data: string,
): UploadedPromptImage {
  const hash = createHash("sha256").update(data).digest("hex");
  const extension = mimeType.split("/")[1]?.replace(/[^a-zA-Z0-9]+/g, "-") || "bin";
  const batchId = "imported";
  const storedName = `${hash}.${extension}`;
  const sessionDir = path.join(uploadsDir, sessionId, batchId);
  const filePath = path.join(sessionDir, storedName);

  fsSync.mkdirSync(sessionDir, { recursive: true });
  if (!fsSync.existsSync(filePath)) {
    fsSync.writeFileSync(filePath, Buffer.from(data, "base64"));
  }

  return {
    name: storedName,
    storedName,
    batchId,
    mimeType,
    size: fsSync.statSync(filePath).size,
    data,
    url: uploadUrl(baseUrl, sessionId, batchId, storedName),
  };
}

function collectInlineImages(
  uploadsDir: string,
  baseUrl: string | undefined,
  sessionId: string,
  messages: unknown[],
): UploadedPromptImage[] {
  const imagesByData = new Map<string, UploadedPromptImage>();

  for (const message of messages) {
    const content = (message as { role?: unknown; content?: unknown }).content;
    if (!Array.isArray(content)) {
      continue;
    }

    for (const block of content) {
      if (
        !block ||
        typeof block !== "object" ||
        (block as { type?: unknown }).type !== "image" ||
        typeof (block as { mimeType?: unknown }).mimeType !== "string" ||
        typeof (block as { data?: unknown }).data !== "string"
      ) {
        continue;
      }

      const data = (block as { data: string }).data;
      if (!imagesByData.has(data)) {
        imagesByData.set(
          data,
          uploadedImageFromInlineData(
            uploadsDir,
            baseUrl,
            sessionId,
            (block as { mimeType: string }).mimeType,
            data,
          ),
        );
      }
    }
  }

  return [...imagesByData.values()];
}

export function externalizeInlineImagesInSession(
  session: AgentSession,
  uploadsDir: string,
  baseUrl?: string,
): void {
  const manager = session.sessionManager as unknown as {
    fileEntries: Array<{ type?: unknown; message?: unknown }>;
  };
  const entryMessages = manager.fileEntries.flatMap((entry) =>
    entry.type === "message" ? [entry.message] : [],
  );
  const uploadedImages = collectInlineImages(uploadsDir, baseUrl, session.sessionId, [
    ...session.messages,
    ...entryMessages,
  ]);

  externalizeUploadedImagesInSession(session, uploadedImages);
}

export async function resolveUploadedFile(
  uploadsDir: string,
  sessionId: string,
  batchId: string,
  storedName: string,
): Promise<{ path: string; mimeType: string }> {
  const filePath = path.join(uploadsDir, sessionId, batchId, sanitizeFileName(storedName));
  const relative = path.relative(uploadsDir, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw Object.assign(new Error("Invalid uploaded file path"), { statusCode: 400 });
  }

  await fs.access(filePath);
  return { path: filePath, mimeType: mime.lookup(filePath) || "application/octet-stream" };
}
