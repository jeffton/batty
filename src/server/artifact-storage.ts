import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export function missingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export async function storageEntries(directory: string) {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (missingFile(error)) return [];
    throw error;
  }
}

export async function storageDirectories(directory: string) {
  return (await storageEntries(directory))
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(directory, entry.name));
}

export async function publishJson(target: string, value: unknown) {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
