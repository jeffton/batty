import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { HarnessSessionStore } from "./harness-session-store";

const tempDirs: string[] = [];

async function currentSessionFile(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-harness-store-"));
  tempDirs.push(root);
  const store = await HarnessSessionStore.create(root, path.join(root, "sessions"));
  const file = store.getSessionFile();
  await store.native.close(BACKGROUND_CONTEXT);
  store.release();
  return file;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((root) => fs.rm(root, { recursive: true })));
});

describe("HarnessSessionStore", () => {
  it("supports concurrent opens of a current session", async () => {
    const file = await currentSessionFile();

    const [first, second] = await Promise.all([
      HarnessSessionStore.open(file),
      HarnessSessionStore.open(file),
    ]);

    expect(first).toBe(second);
    await first.native.close(BACKGROUND_CONTEXT);
    first.release();
  });

  it("does not repair malformed current sessions while indexing", async () => {
    const file = await currentSessionFile();
    const malformed = `${await fs.readFile(file, "utf8")}{`;
    await fs.writeFile(file, malformed);

    await expect(HarnessSessionStore.read(file, { readOnly: true })).rejects.toThrow();
    expect(await fs.readFile(file, "utf8")).toBe(malformed);
  });
});
