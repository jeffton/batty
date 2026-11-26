import fs from "node:fs/promises";
import path from "node:path";
import {
  fileLibraryRef,
  siteLibraryRef,
  type ArtifactLibraryItem,
} from "@/shared/artifact-library";
import { missingFile, publishJson } from "./artifact-storage";
import type { AppConfig } from "./config";
import { stateDirPath } from "./options";
import { resolveSentFile, storedSentFiles } from "./send-files";
import { listStoredSites } from "./sites";
import { resolveUploadedFile, storedUploadedFiles } from "./uploads";

type LibraryConfig = Pick<
  AppConfig,
  "battyDir" | "sentFilesDir" | "uploadsDir" | "sitesDir" | "baseUrl"
>;

function missingRef(ref: string) {
  return Object.assign(new Error(`Artifact not found: ${ref}`), { statusCode: 404 });
}

function withStars(items: ArtifactLibraryItem[], stars: ReadonlySet<string>) {
  return items
    .map((item) => ({ ...item, starred: stars.has(item.ref) }))
    .sort(
      (a, b) =>
        Number(b.starred) - Number(a.starred) ||
        b.createdAt.localeCompare(a.createdAt) ||
        a.ref.localeCompare(b.ref),
    );
}

export class ArtifactLibrary {
  private readonly starsPath: string;
  private writes = Promise.resolve();

  constructor(private readonly config: LibraryConfig) {
    this.starsPath = path.join(stateDirPath(config.battyDir), "artifact-stars.json");
  }

  async list(): Promise<ArtifactLibraryItem[]> {
    const [items, stars] = await Promise.all([this.items(), this.readStars()]);
    return withStars(items, stars);
  }

  setStar(ref: string, starred: boolean): Promise<ArtifactLibraryItem[]> {
    const write = this.writes.then(async () => {
      const [items, stars] = await Promise.all([this.items(), this.readStars()]);
      if (!items.some((item) => item.ref === ref)) throw missingRef(ref);
      if (stars.has(ref) !== starred) {
        if (starred) stars.add(ref);
        else stars.delete(ref);
        await fs.mkdir(path.dirname(this.starsPath), { recursive: true });
        await publishJson(this.starsPath, [...stars]);
      }
      return withStars(items, stars);
    });
    this.writes = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }

  async resolve(refs: readonly string[]): Promise<ArtifactLibraryItem[]> {
    if (!refs.length) return [];
    const [items, stars] = await Promise.all([this.items(), this.readStars()]);
    const byRef = new Map(items.map((item) => [item.ref, item]));
    return [...new Set(refs)].map((ref) => {
      const item = byRef.get(ref);
      if (!item) throw missingRef(ref);
      return { ...item, starred: stars.has(ref) };
    });
  }

  async resolveFileSource(ref: string): Promise<{ name: string; path: string }> {
    if (!ref.startsWith("file:")) throw missingRef(ref);
    const fileId = ref.slice("file:".length);
    const { sentFilesDir, uploadsDir, baseUrl } = this.config;
    if (/^[0-9a-f]{64}$/.test(fileId)) {
      for await (const { file, location } of storedUploadedFiles(uploadsDir, baseUrl, fileId)) {
        const { sessionId, batchId, storedName } = location;
        const resolved = await resolveUploadedFile(uploadsDir, sessionId, batchId, storedName);
        return { name: file.name, path: resolved.path };
      }
    } else {
      for await (const { location } of storedSentFiles(sentFilesDir, baseUrl, fileId)) {
        const { descriptor, storedPath } = await resolveSentFile({
          rootDir: sentFilesDir,
          baseUrl,
          ...location,
        });
        return { name: descriptor.name, path: storedPath };
      }
    }
    throw missingRef(ref);
  }

  private async items(): Promise<ArtifactLibraryItem[]> {
    const { sentFilesDir, uploadsDir, sitesDir, baseUrl } = this.config;
    const [generated, uploads, sites] = await Promise.all([
      Array.fromAsync(storedSentFiles(sentFilesDir, baseUrl)),
      Array.fromAsync(storedUploadedFiles(uploadsDir, baseUrl)),
      listStoredSites(sitesDir, baseUrl),
    ]);
    return [
      ...generated.map(({ file, createdAt }) => fileItem(file, createdAt, "generated")),
      ...uploads.map(({ file, createdAt }) => fileItem(file, createdAt, "upload")),
      ...sites.map(({ site, createdAt }): ArtifactLibraryItem => ({
        kind: "site",
        ref: siteLibraryRef(site.id),
        title: site.name,
        createdAt: new Date(createdAt).toISOString(),
        starred: false,
        site,
      })),
    ];
  }

  private async readStars(): Promise<Set<string>> {
    try {
      return new Set(JSON.parse(await fs.readFile(this.starsPath, "utf8")) as string[]);
    } catch (error) {
      if (missingFile(error)) return new Set();
      throw error;
    }
  }
}

function fileItem(
  file: Extract<ArtifactLibraryItem, { kind: "file" }>["file"],
  createdAt: number,
  source: "generated" | "upload",
): ArtifactLibraryItem {
  return {
    kind: "file",
    ref: fileLibraryRef(file.id),
    title: file.name,
    createdAt: new Date(createdAt).toISOString(),
    starred: false,
    source,
    file,
  };
}
