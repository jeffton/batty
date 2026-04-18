import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import mime from "mime-types";
import type { UploadedFile } from "./pi-service-types";

export interface PreparedPromptFiles {
  text: string;
  images: Array<{ type: "image"; mimeType: string; data: string }>;
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function isImageMimeType(value: false | string): value is string {
  return typeof value === "string" && value.startsWith("image/");
}

async function processUploadedFiles(filePaths: string[]): Promise<PreparedPromptFiles> {
  let text = "";
  const images: PreparedPromptFiles["images"] = [];

  for (const filePath of filePaths) {
    const fileName = path.basename(filePath);
    const mimeType = mime.lookup(filePath);
    if (isImageMimeType(mimeType)) {
      const data = (await fs.readFile(filePath)).toString("base64");
      images.push({ type: "image", mimeType, data });
      text += `<file name="${fileName}"></file>\n`;
      continue;
    }

    const content = await fs.readFile(filePath, "utf8");
    text += `<file name="${fileName}">\n${content}\n</file>\n`;
  }

  return { text, images };
}

export async function preparePromptFiles(
  uploadsDir: string,
  sessionId: string,
  files: UploadedFile[],
): Promise<PreparedPromptFiles> {
  if (files.length === 0) {
    return { text: "", images: [] };
  }

  const sessionDir = path.join(uploadsDir, sessionId, randomUUID());
  await ensureDir(sessionDir);

  const savedPaths: string[] = [];
  for (const file of files) {
    const targetPath = path.join(sessionDir, sanitizeFileName(file.filename || "attachment.bin"));
    await fs.writeFile(targetPath, file.data);
    savedPaths.push(targetPath);
  }

  return processUploadedFiles(savedPaths);
}
