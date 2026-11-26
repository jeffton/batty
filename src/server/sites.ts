import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import mime from "mime-types";
import type { SiteDescriptor } from "@/shared/types";
import { publishJson, storageDirectories } from "./artifact-storage";

interface SiteManifest {
  id: string;
  name: string;
  public: boolean;
  accessToken: string;
  createdAt: number;
}

export interface ResolvedSiteFile {
  descriptor: SiteDescriptor;
  filePath: string;
  mimeType: string;
  accessToken: string;
}

const MANIFEST_FILE = "manifest.json";
const CONTENT_DIR = "content";

function siteDirectory(rootDir: string, siteId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(siteId)) {
    throw Object.assign(new Error("Site not found"), { statusCode: 404 });
  }
  return path.join(rootDir, siteId);
}

function normalizeBaseUrl(baseUrl: string): string {
  return !baseUrl || baseUrl === "/" ? "" : `/${baseUrl.replace(/^\/+|\/+$/g, "")}`;
}

function siteUrl(baseUrl: string, siteId: string): string {
  return `${normalizeBaseUrl(baseUrl)}/sites/${encodeURIComponent(siteId)}/`;
}

function browserSiteUrl(baseUrl: string, siteId: string, accessToken: string): string {
  return `${normalizeBaseUrl(baseUrl)}/site-preview/${encodeURIComponent(siteId)}/${encodeURIComponent(accessToken)}/`;
}

function descriptor(manifest: SiteManifest, baseUrl: string): SiteDescriptor {
  return {
    kind: "site",
    id: manifest.id,
    name: manifest.name,
    url: siteUrl(baseUrl, manifest.id),
    public: manifest.public,
  };
}

async function readManifest(rootDir: string, siteId: string): Promise<SiteManifest> {
  try {
    return JSON.parse(
      await fs.readFile(path.join(siteDirectory(rootDir, siteId), MANIFEST_FILE), "utf8"),
    ) as SiteManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw Object.assign(new Error("Site not found"), { statusCode: 404 });
    }
    throw error;
  }
}

export async function listStoredSites(rootDir: string, baseUrl: string) {
  const records: { site: SiteDescriptor; createdAt: number }[] = [];
  for (const directory of await storageDirectories(rootDir)) {
    const record = await getReadyStoredSite(rootDir, baseUrl, path.basename(directory));
    if (record) records.push(record);
  }
  return records;
}

export async function getReadyStoredSite(rootDir: string, baseUrl: string, id: string) {
  try {
    if (!(await fs.lstat(siteDirectory(rootDir, id))).isDirectory()) return;
    const manifest = await readManifest(rootDir, id);
    if (manifest.id === id && (await resolveSiteContent(rootDir, id, "index.html")).size > 0)
      return { site: descriptor(manifest, baseUrl), createdAt: manifest.createdAt };
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    if (status !== 404 && status !== 400 && (error as NodeJS.ErrnoException).code !== "ENOENT")
      throw error;
  }
}

export async function createSite(
  rootDir: string,
  baseUrl: string,
  name: string,
): Promise<{ descriptor: SiteDescriptor; directory: string; browserUrl: string }> {
  const id = randomUUID();
  const directory = path.join(siteDirectory(rootDir, id), CONTENT_DIR);
  const manifest: SiteManifest = {
    id,
    name: name.trim() || "Site",
    public: false,
    accessToken: randomBytes(24).toString("base64url"),
    createdAt: Date.now(),
  };
  await fs.mkdir(directory, { recursive: true });
  await publishJson(path.join(siteDirectory(rootDir, id), MANIFEST_FILE), manifest);
  const site = descriptor(manifest, baseUrl);
  return {
    descriptor: site,
    directory,
    browserUrl: browserSiteUrl(baseUrl, manifest.id, manifest.accessToken),
  };
}

export async function getSite(
  rootDir: string,
  baseUrl: string,
  siteId: string,
): Promise<{
  descriptor: SiteDescriptor;
  directory: string;
  browserUrl: string;
}> {
  const manifest = await readManifest(rootDir, siteId);
  const site = descriptor(manifest, baseUrl);
  return {
    descriptor: site,
    directory: path.join(siteDirectory(rootDir, siteId), CONTENT_DIR),
    browserUrl: browserSiteUrl(baseUrl, manifest.id, manifest.accessToken),
  };
}

export async function deleteSite(rootDir: string, siteId: string): Promise<void> {
  await readManifest(rootDir, siteId);
  await fs.rm(siteDirectory(rootDir, siteId), { recursive: true });
}

export async function setSitePublic(
  rootDir: string,
  baseUrl: string,
  siteId: string,
  isPublic: boolean,
): Promise<SiteDescriptor> {
  const manifest = await readManifest(rootDir, siteId);
  manifest.public = isPublic;
  await publishJson(path.join(siteDirectory(rootDir, siteId), MANIFEST_FILE), manifest);
  return descriptor(manifest, baseUrl);
}

function requestedRelativePath(value: string): string {
  const decoded = decodeURIComponent(value || "index.html");
  const normalized = decoded.replaceAll("\\", "/");
  if (path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw Object.assign(new Error("Invalid site path"), { statusCode: 400 });
  }
  return normalized.endsWith("/") ? `${normalized}index.html` : normalized;
}

async function resolveSiteContent(rootDir: string, siteId: string, requestPath: string) {
  const contentRoot = path.join(siteDirectory(rootDir, siteId), CONTENT_DIR);
  const relativePath = requestedRelativePath(requestPath);
  let filePath = path.resolve(contentRoot, relativePath);

  if (filePath !== contentRoot && !filePath.startsWith(`${contentRoot}${path.sep}`)) {
    throw Object.assign(new Error("Invalid site path"), { statusCode: 400 });
  }

  try {
    const stats = await fs.stat(filePath);
    if (stats.isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }
    const [realRoot, realFile] = await Promise.all([
      fs.realpath(contentRoot),
      fs.realpath(filePath),
    ]);
    if (realFile !== realRoot && !realFile.startsWith(`${realRoot}${path.sep}`)) {
      throw Object.assign(new Error("Invalid site path"), { statusCode: 400 });
    }
    const file = await fs.stat(realFile);
    if (!file.isFile()) {
      throw Object.assign(new Error("Site file not found"), { statusCode: 404 });
    }
    return { filePath: realFile, size: file.size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw Object.assign(new Error("Site file not found"), { statusCode: 404 });
    }
    throw error;
  }
}

export async function resolveSiteFile(
  rootDir: string,
  baseUrl: string,
  siteId: string,
  requestPath: string,
): Promise<ResolvedSiteFile> {
  const manifest = await readManifest(rootDir, siteId);
  const { filePath } = await resolveSiteContent(rootDir, siteId, requestPath);
  return {
    descriptor: descriptor(manifest, baseUrl),
    filePath,
    mimeType: mime.lookup(filePath) || "application/octet-stream",
    accessToken: manifest.accessToken,
  };
}
