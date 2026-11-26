import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { missingFile } from "./artifact-storage";
import type { ArtifactLibraryItem } from "@/shared/artifact-library";

type FileItem = Extract<ArtifactLibraryItem, { kind: "file" }>;

export type GeneratedFileRow = { item: FileItem; storedPath: string };
export type GeneratedFileGroup = { item: FileItem; refs: string[] };
export type FileDigests = Map<string, { version: string; digest: string }>;

function newestFirst(a: FileItem, b: FileItem): number {
  return b.createdAt.localeCompare(a.createdAt) || a.ref.localeCompare(b.ref);
}

async function sha256(storedPath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(storedPath)) hash.update(chunk);
  return hash.digest("hex");
}

async function digestFor(row: GeneratedFileRow, digests: FileDigests) {
  const metadata = await stat(row.storedPath, { bigint: true });
  const version = `${metadata.ino}:${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}`;
  const previous = digests.get(row.item.ref);
  if (previous?.version === version) return previous.digest;
  const digest = await sha256(row.storedPath);
  digests.set(row.item.ref, { version, digest });
  return digest;
}

async function groupBucket(
  rows: GeneratedFileRow[],
  digests: FileDigests,
): Promise<GeneratedFileGroup[]> {
  const byDigest = new Map<string, GeneratedFileGroup>();
  for (const row of rows.sort((a, b) => newestFirst(a.item, b.item))) {
    const { item } = row;
    let digest: string;
    try {
      digest = await digestFor(row, digests);
    } catch (error) {
      if (missingFile(error)) continue;
      throw error;
    }
    const group = byDigest.get(digest);
    if (group) group.refs.push(item.ref);
    else byDigest.set(digest, { item, refs: [item.ref] });
  }
  return [...byDigest.values()];
}

export async function groupGeneratedFiles(
  records: readonly GeneratedFileRow[],
  digests: FileDigests,
): Promise<GeneratedFileGroup[]> {
  const buckets = new Map<string, GeneratedFileRow[]>();
  const groups: GeneratedFileGroup[] = [];
  for (const row of records) {
    const { item } = row;
    if (item.source !== "generated") {
      groups.push({ item, refs: [item.ref] });
      continue;
    }
    const key = JSON.stringify([item.title, item.file.mimeType, item.file.size]);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(row);
    else buckets.set(key, [row]);
  }

  for (const bucket of buckets.values()) {
    const first = bucket[0]!;
    if (bucket.length === 1) groups.push({ item: first.item, refs: [first.item.ref] });
    else groups.push(...(await groupBucket(bucket, digests)));
  }
  return groups.sort((a, b) => newestFirst(a.item, b.item));
}
