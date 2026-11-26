import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  artifactTextUrl,
  fileLibraryRef,
  siteLibraryRef,
  type ArtifactLibraryItem,
  type ArtifactLibraryResponse,
} from "@/shared/artifact-library";
import { groupGeneratedFiles, type FileDigests } from "./artifact-file-groups";
import { missingFile, publishJson } from "./artifact-storage";
import { hasTextPreview } from "./artifact-text";
import type { AppConfig } from "./config";
import { stateDirPath } from "./options";
import { storedSentFiles } from "./send-files";
import { getSite, listStoredSites } from "./sites";
import { storedUploadedFiles } from "./uploads";

type LibraryConfig = Pick<
  AppConfig,
  "battyDir" | "sentFilesDir" | "uploadsDir" | "sitesDir" | "baseUrl"
>;
type LibraryFile = Extract<ArtifactLibraryItem, { kind: "file" }>;
type LibrarySite = Extract<ArtifactLibraryItem, { kind: "site" }>;
type RowKey = Pick<ArtifactLibraryItem, "starred" | "createdAt" | "ref">;
type CatalogGroup = { item: ArtifactLibraryItem; refs: string[] };
type Catalog = {
  groups: CatalogGroup[];
  files: Map<string, string>;
  rows: ArtifactLibraryItem[];
  revision: string;
};

function missingRef(ref: string) {
  return Object.assign(new Error(`Artifact not found: ${ref}`), { statusCode: 404 });
}

function compareRows(a: RowKey, b: RowKey) {
  return (
    Number(b.starred) - Number(a.starred) ||
    b.createdAt.localeCompare(a.createdAt) ||
    a.ref.localeCompare(b.ref)
  );
}

function visibleRows(groups: CatalogGroup[], stars: ReadonlySet<string>) {
  return groups
    .map(({ item, refs }) => ({ ...item, starred: refs.some((ref) => stars.has(ref)) }))
    .sort(compareRows);
}

function catalogRevision(rows: ArtifactLibraryItem[]) {
  return createHash("sha256").update(JSON.stringify(rows)).digest("base64url");
}

function cursorFor(revision: string, offset: number) {
  return `${revision}.${offset}`;
}

function parseCursor(cursor: string) {
  const match = /^([A-Za-z0-9_-]{43})\.([1-9]\d*)$/.exec(cursor);
  const offset = Number(match?.[2]);
  if (!match || !Number.isSafeInteger(offset))
    throw Object.assign(new Error("Invalid artifact cursor"), { statusCode: 400 });
  return { revision: match[1], offset };
}

export class ArtifactCatalogChanged extends Error {
  constructor() {
    super("Artifact list changed");
  }
}

export class ArtifactLibrary {
  private readonly starsPath: string;
  private writes = Promise.resolve();
  private current?: Catalog;
  private refreshing?: Promise<Catalog>;
  private readonly digests: FileDigests = new Map();

  constructor(private readonly config: LibraryConfig) {
    this.starsPath = path.join(stateDirPath(config.battyDir), "artifact-stars.json");
  }

  async list(): Promise<ArtifactLibraryItem[]> {
    return (await this.refresh()).rows;
  }

  async page(limit: number, after?: string): Promise<ArtifactLibraryResponse> {
    const cursor = after === undefined ? undefined : parseCursor(after);
    const catalog = cursor && this.current ? this.current : await this.refresh();
    if (cursor && cursor.revision !== catalog.revision) throw new ArtifactCatalogChanged();
    return this.slice(catalog, limit, cursor?.offset);
  }

  setStar(ref: string, starred: boolean, limit: number): Promise<ArtifactLibraryResponse> {
    const write = this.writes.then(async () => {
      const catalog = this.refreshing
        ? await this.refreshing
        : (this.current ?? (await this.refresh()));
      const stars = await this.readStars();
      const existing = catalog.groups.find(({ refs }) => refs.includes(ref));
      if (!existing) await this.find(ref);
      const refs = existing?.refs ?? [ref];
      if (refs.some((alias) => stars.has(alias)) !== starred) {
        if (starred) stars.add(existing?.item.ref ?? ref);
        else for (const alias of refs) stars.delete(alias);
        await fs.mkdir(path.dirname(this.starsPath), { recursive: true });
        await publishJson(this.starsPath, [...stars]);
      }
      const latest = this.refreshing ? await this.refreshing : (this.current ?? catalog);
      const rows = visibleRows(latest.groups, stars);
      const published = { ...latest, rows, revision: catalogRevision(rows) };
      this.current = published;
      return this.slice(published, limit);
    });
    this.writes = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }

  async resolve(refs: readonly string[]): Promise<ArtifactLibraryItem[]> {
    if (!refs.length) return [];
    const stars = await this.readStars();
    return Promise.all(
      [...new Set(refs)].map(async (ref) => ({
        ...(await this.find(ref)).item,
        starred: stars.has(ref),
      })),
    );
  }

  async resolveFileSource(ref: string): Promise<{ name: string; path: string }> {
    const { item, storedPath } = await this.findFile(ref);
    return { name: item.title, path: storedPath };
  }

  private async find(ref: string): Promise<{ item: ArtifactLibraryItem }> {
    if (!ref.startsWith("site:")) return this.findFile(ref);
    const { sitesDir, baseUrl } = this.config;
    try {
      const { descriptor, createdAt } = await getSite(sitesDir, baseUrl, ref.slice("site:".length));
      return { item: siteItem(descriptor, createdAt) };
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404) throw missingRef(ref);
      throw error;
    }
  }

  private async findFile(ref: string) {
    if (!ref.startsWith("file:")) throw missingRef(ref);
    const id = ref.slice("file:".length);
    const { sentFilesDir, uploadsDir, baseUrl } = this.config;
    if (/^[0-9a-f]{64}$/.test(id)) {
      for await (const row of storedUploadedFiles(uploadsDir, baseUrl, id)) {
        return { item: fileItem(row.file, row.createdAt, "upload"), storedPath: row.storedPath };
      }
    } else {
      for await (const row of storedSentFiles(sentFilesDir, baseUrl, id)) {
        return { item: fileItem(row.file, row.createdAt, "generated"), storedPath: row.storedPath };
      }
    }
    throw missingRef(ref);
  }

  private refresh() {
    return (this.refreshing ??= this.catalog()
      .then((catalog) => (this.current = catalog))
      .finally(() => {
        this.refreshing = undefined;
      }));
  }

  private async catalog(): Promise<Catalog> {
    const { sentFilesDir, uploadsDir, sitesDir, baseUrl } = this.config;
    const [generated, uploads, sites, stars] = await Promise.all([
      Array.fromAsync(storedSentFiles(sentFilesDir, baseUrl)),
      Array.fromAsync(storedUploadedFiles(uploadsDir, baseUrl)),
      listStoredSites(sitesDir, baseUrl),
      this.readStars(),
    ]);
    const files = new Map(
      [...generated, ...uploads].map(({ file, storedPath }) => [file.id, storedPath]),
    );
    const outputs = await groupGeneratedFiles(
      generated.map(({ file, createdAt, storedPath }) => ({
        item: fileItem(file, createdAt, "generated"),
        storedPath,
      })),
      this.digests,
    );
    const other = [
      ...uploads.map(({ file, createdAt }) => fileItem(file, createdAt, "upload")),
      ...sites.map(({ site, createdAt }) => siteItem(site, createdAt)),
    ];
    const groups = [...outputs, ...other.map((item) => ({ item, refs: [item.ref] }))];
    const rows = visibleRows(groups, stars);
    return { groups, files, rows, revision: catalogRevision(rows) };
  }

  private async slice(
    catalog: Catalog,
    limit: number,
    start = 0,
  ): Promise<ArtifactLibraryResponse> {
    const { rows, files } = catalog;
    const end = start + limit;
    const artifacts = await Promise.all(
      rows.slice(start, end).map(async (item) => {
        if (item.kind !== "file") return item;
        if (!(await hasTextPreview(item.file, files.get(item.file.id)!))) return item;
        return { ...item, textPreviewUrl: artifactTextUrl(item.file.downloadUrl) };
      }),
    );
    return {
      artifacts,
      ...(end < rows.length ? { nextCursor: cursorFor(catalog.revision, end) } : {}),
    };
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
  file: LibraryFile["file"],
  createdAt: number,
  source: LibraryFile["source"],
): LibraryFile {
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

function siteItem(site: LibrarySite["site"], createdAt: number): LibrarySite {
  return {
    kind: "site",
    ref: siteLibraryRef(site.id),
    title: site.name,
    createdAt: new Date(createdAt).toISOString(),
    starred: false,
    site,
  };
}
