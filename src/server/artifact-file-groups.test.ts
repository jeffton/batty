import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vite-plus/test";
import { groupGeneratedFiles, type GeneratedFileRow } from "./artifact-file-groups";

type FileOptions = {
  title?: string;
  mimeType?: string;
  size?: number;
  createdAt?: string;
  starred?: boolean;
  source?: "generated" | "upload";
};

function row(directory: string, id: string, options: FileOptions = {}): GeneratedFileRow {
  const {
    title = "report.txt",
    mimeType = "text/plain",
    size = 3,
    createdAt = "2026-11-26T00:00:00.000Z",
    starred = false,
    source = "generated",
  } = options;
  return {
    storedPath: path.join(directory, id),
    item: {
      kind: "file",
      source,
      ref: `file:${id}`,
      title,
      createdAt,
      starred,
      file: { id, name: title, mimeType, size, kind: "file", downloadUrl: `/files/${id}` },
    },
  };
}

test("groups matching file bytes, keeps every ref and picks the newest, then lowest ref", async ({
  onTestFinished,
}) => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "batty-artifact-file-groups-"));
  onTestFinished(() => fs.rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.alloc(130 * 1024);
  const differentBytes = Buffer.from(bytes);
  differentBytes[differentBytes.length - 1] = 1;
  const older = row(directory, "old", {
    size: bytes.length,
    createdAt: "2026-11-25T00:00:00.000Z",
    starred: true,
  });
  const first = row(directory, "a", { size: bytes.length });
  const tied = row(directory, "b", { size: bytes.length });
  const distinct = row(directory, "different", { size: bytes.length });
  await Promise.all([
    ...[older, first, tied].map(({ storedPath }) => fs.writeFile(storedPath, bytes)),
    fs.writeFile(distinct.storedPath, differentBytes),
  ]);

  const expected = [
    { item: first.item, refs: [first.item.ref, tied.item.ref, older.item.ref] },
    { item: distinct.item, refs: [distinct.item.ref] },
  ];
  const cache = new Map();
  expect(await groupGeneratedFiles([older, distinct, tied, first], cache)).toEqual(expected);
  expect(await groupGeneratedFiles([first, distinct, older, tied], cache)).toEqual(expected);
  await fs.writeFile(distinct.storedPath, bytes);
  expect(await groupGeneratedFiles([first, distinct, older, tied], cache)).toEqual([
    { item: first.item, refs: [first.item.ref, tied.item.ref, distinct.item.ref, older.item.ref] },
  ]);
});

test("does not read files if title, MIME or size puts them in separate buckets", async () => {
  const directory = path.join(tmpdir(), "batty-artifact-file-groups-absent");
  const records = [
    row(directory, "default"),
    row(directory, "mime", { mimeType: "text/csv" }),
    row(directory, "name", { title: "Report.txt" }),
    row(directory, "size", { size: 4 }),
    row(directory, "upload", { source: "upload" }),
  ];

  expect(await groupGeneratedFiles(records, new Map())).toEqual(
    records.map(({ item }) => ({ item, refs: [item.ref] })),
  );
});

test("an unavailable duplicate does not hide the surviving file", async ({ onTestFinished }) => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "batty-artifact-file-groups-"));
  onTestFinished(() => fs.rm(directory, { recursive: true, force: true }));
  const present = row(directory, "b");
  await fs.writeFile(present.storedPath, "data");
  expect(await groupGeneratedFiles([row(directory, "a"), present], new Map())).toEqual([
    { item: present.item, refs: [present.item.ref] },
  ]);
});
