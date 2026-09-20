import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/pi-agent-core";
import { HarnessSessionStore, readHarnessSessionMetadata } from "./harness-session-store";
import { legacySessionImageDirectory, migrateSessionImages } from "./session-images";
import { battySessionRootDir } from "./pi-paths";

export interface SessionMigrationResult {
  scanned: number;
  migrated: number;
  repaired: number;
}

async function sessionFiles(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

function records(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(records);
  return value && typeof value === "object" ? [value as Record<string, unknown>] : [];
}

async function syncFileAndDirectory(file: string): Promise<void> {
  const handle = await fs.open(file, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (process.platform === "win32") return;
  const directoryHandle = await fs.open(path.dirname(file), "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

async function repairImportedReplyIds(file: string): Promise<boolean> {
  const original = await fs.readFile(file, "utf8");
  if (!original.includes('"batty.imported-reply-ids"')) return false;
  const lines = original.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const parsed = lines.map((line) => JSON.parse(line));
  let mapping: Record<string, string> = {};

  for (const line of parsed) {
    for (const record of records(line)) {
      if (
        record.kind === "value" &&
        record.namespace === "batty.imported-reply-ids" &&
        record.key === ""
      ) {
        mapping =
          record.op === "set" && record.value && typeof record.value === "object"
            ? (record.value as Record<string, string>)
            : {};
      }
    }
  }

  let changed = false;
  for (const line of parsed) {
    for (const record of records(line)) {
      if (
        record.kind !== "entry" ||
        record.type !== "custom" ||
        record.customType !== "batty-agent-turn-file-changes" ||
        !record.data ||
        typeof record.data !== "object"
      ) {
        continue;
      }
      const data = record.data as Record<string, unknown>;
      if (typeof data.replyEntryId !== "string") continue;
      const remapped = mapping[data.replyEntryId];
      if (!remapped) continue;
      data.replyEntryId = remapped;
      changed = true;
    }
  }

  if (!changed) return false;
  const trailingNewline = original.endsWith("\n") ? "\n" : "";
  const content = `${parsed.map((line) => JSON.stringify(line)).join("\n")}${trailingNewline}`;
  const temporary = `${file}.migration-${randomUUID()}.tmp`;
  const stat = await fs.stat(file);
  try {
    await fs.writeFile(temporary, content, { mode: stat.mode });
    await syncFileAndDirectory(temporary);
    await fs.rename(temporary, file);
    await syncFileAndDirectory(file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return true;
}

export async function migrateLegacySessions(battyDir: string): Promise<SessionMigrationResult> {
  const files = await sessionFiles(battySessionRootDir({ battyDir }));
  let migrated = 0;
  let repaired = 0;
  const sharedDirectories = new Map<string, boolean>();

  for (const file of files) {
    const sharedDirectory = legacySessionImageDirectory(file);
    const imageMigrationComplete = await migrateSessionImages(file);
    sharedDirectories.set(
      sharedDirectory,
      (sharedDirectories.get(sharedDirectory) ?? true) && imageMigrationComplete,
    );
    const metadata = await readHarnessSessionMetadata(file);
    if (!("v" in metadata)) {
      const originalMode = (await fs.stat(file)).mode;
      const store = await HarnessSessionStore.open(file);
      try {
        await fs.chmod(file, originalMode);
        await syncFileAndDirectory(file);
        migrated++;
      } finally {
        await store.native.close(context);
        store.release();
      }
    }
    if (await repairImportedReplyIds(file)) repaired++;
  }

  for (const [directory, complete] of sharedDirectories) {
    if (complete) await fs.rm(directory, { recursive: true, force: true });
  }

  return { scanned: files.length, migrated, repaired };
}
