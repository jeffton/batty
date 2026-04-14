import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import mime from "mime-types";
import type { SentFileDescriptor } from "@/shared/types";

interface StoredSentFileRecord {
  id: string;
  name: string;
  storedName: string;
  size: number;
  mimeType: string;
  kind: "file" | "image" | "video";
}

interface StoredSentFileManifest {
  workspaceId: string;
  sessionId: string;
  toolCallId: string;
  createdAt: number;
  files: StoredSentFileRecord[];
}

export interface StoreSentFilesOptions {
  rootDir: string;
  workspaceId: string;
  sessionId: string;
  toolCallId: string;
  cwd: string;
  paths: string[];
}

export interface ResolveSentFileOptions {
  rootDir: string;
  workspaceId: string;
  sessionId: string;
  toolCallId: string;
  fileId: string;
}

export interface ResolvedSentFile {
  descriptor: SentFileDescriptor;
  storedPath: string;
}

const MANIFEST_FILE_NAME = "manifest.json";

function sanitizeStorageSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function sanitizeStoredFileName(name: string): string {
  const trimmed = name.trim();
  const sanitized = path.basename(trimmed).replace(/[^a-zA-Z0-9._-]+/g, "-");
  return sanitized.length > 0 ? sanitized : "file";
}

function detectFileKind(mimeType: string): "file" | "image" | "video" {
  if (mimeType.startsWith("image/")) {
    return "image";
  }
  if (mimeType.startsWith("video/")) {
    return "video";
  }
  return "file";
}

function toolDirectory(
  rootDir: string,
  workspaceId: string,
  sessionId: string,
  toolCallId: string,
): string {
  return path.join(
    rootDir,
    sanitizeStorageSegment(workspaceId),
    sanitizeStorageSegment(sessionId),
    sanitizeStorageSegment(toolCallId),
  );
}

function sentFileUrl(
  workspaceId: string,
  sessionId: string,
  toolCallId: string,
  fileId: string,
  download: boolean,
): string {
  const base = [workspaceId, sessionId, toolCallId, fileId].map(encodeURIComponent).join("/");
  return `/api/sent-files/${base}${download ? "?download=1" : ""}`;
}

function toDescriptor(
  workspaceId: string,
  sessionId: string,
  toolCallId: string,
  file: StoredSentFileRecord,
): SentFileDescriptor {
  return {
    id: file.id,
    name: file.name,
    size: file.size,
    mimeType: file.mimeType,
    kind: file.kind,
    downloadUrl: sentFileUrl(workspaceId, sessionId, toolCallId, file.id, true),
    previewUrl:
      file.kind === "image" || file.kind === "video"
        ? sentFileUrl(workspaceId, sessionId, toolCallId, file.id, false)
        : undefined,
  };
}

async function readManifest(
  rootDir: string,
  workspaceId: string,
  sessionId: string,
  toolCallId: string,
): Promise<StoredSentFileManifest> {
  const manifestPath = path.join(
    toolDirectory(rootDir, workspaceId, sessionId, toolCallId),
    MANIFEST_FILE_NAME,
  );
  return JSON.parse(await fs.readFile(manifestPath, "utf8")) as StoredSentFileManifest;
}

export async function storeSentFiles(
  options: StoreSentFilesOptions,
): Promise<SentFileDescriptor[]> {
  const paths = options.paths
    .map((filePath) => filePath.trim())
    .filter((filePath) => filePath.length > 0);
  if (paths.length === 0) {
    throw new Error("paths must contain at least one file");
  }

  const dir = toolDirectory(
    options.rootDir,
    options.workspaceId,
    options.sessionId,
    options.toolCallId,
  );
  await fs.mkdir(dir, { recursive: true });

  const files: StoredSentFileRecord[] = [];
  for (const [index, inputPath] of paths.entries()) {
    const resolvedPath = path.resolve(options.cwd, inputPath);
    const stats = await fs.stat(resolvedPath);
    if (!stats.isFile()) {
      throw new Error(`Path is not a file: ${inputPath}`);
    }

    const originalName = path.basename(resolvedPath);
    const storedName = `${String(index + 1).padStart(2, "0")}-${sanitizeStoredFileName(originalName)}`;
    const mimeType = mime.lookup(originalName) || "application/octet-stream";
    const file: StoredSentFileRecord = {
      id: randomUUID(),
      name: originalName,
      storedName,
      size: stats.size,
      mimeType,
      kind: detectFileKind(mimeType),
    };

    await fs.copyFile(resolvedPath, path.join(dir, storedName));
    files.push(file);
  }

  const manifest: StoredSentFileManifest = {
    workspaceId: options.workspaceId,
    sessionId: options.sessionId,
    toolCallId: options.toolCallId,
    createdAt: Date.now(),
    files,
  };
  await fs.writeFile(
    path.join(dir, MANIFEST_FILE_NAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  return files.map((file) =>
    toDescriptor(options.workspaceId, options.sessionId, options.toolCallId, file),
  );
}

export async function resolveSentFile(options: ResolveSentFileOptions): Promise<ResolvedSentFile> {
  const manifest = await readManifest(
    options.rootDir,
    options.workspaceId,
    options.sessionId,
    options.toolCallId,
  );
  const file = manifest.files.find((candidate) => candidate.id === options.fileId);
  if (!file) {
    throw Object.assign(new Error(`Sent file not found: ${options.fileId}`), { statusCode: 404 });
  }

  return {
    descriptor: toDescriptor(options.workspaceId, options.sessionId, options.toolCallId, file),
    storedPath: path.join(
      toolDirectory(options.rootDir, options.workspaceId, options.sessionId, options.toolCallId),
      file.storedName,
    ),
  };
}
