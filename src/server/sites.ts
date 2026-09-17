import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import mime from "mime-types";
import type { SiteDescriptor } from "@/shared/types";

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
  await fs.writeFile(
    path.join(siteDirectory(rootDir, id), MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
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
): Promise<{ descriptor: SiteDescriptor; directory: string; browserUrl: string }> {
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
  await fs.writeFile(
    path.join(siteDirectory(rootDir, siteId), MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
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

export async function resolveSiteFile(
  rootDir: string,
  baseUrl: string,
  siteId: string,
  requestPath: string,
): Promise<ResolvedSiteFile> {
  const manifest = await readManifest(rootDir, siteId);
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
    if (!(await fs.stat(realFile)).isFile()) {
      throw Object.assign(new Error("Site file not found"), { statusCode: 404 });
    }
    filePath = realFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw Object.assign(new Error("Site file not found"), { statusCode: 404 });
    }
    throw error;
  }

  return {
    descriptor: descriptor(manifest, baseUrl),
    filePath,
    mimeType: mime.lookup(filePath) || "application/octet-stream",
    accessToken: manifest.accessToken,
  };
}
