import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vite-plus/test";
import { loadAppOptions, writeStoredOptions } from "./options";

test("application baseUrl remains a mount path and rejects network URLs", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "batty-base-path-"));
  try {
    expect((await loadAppOptions(directory)).baseUrl).toBe("/");
    await writeStoredOptions(directory, { baseUrl: "/batty/" });
    expect((await loadAppOptions(directory)).baseUrl).toBe("/batty");
    for (const baseUrl of [
      "https://example.test/batty/",
      "//example.test/batty/",
      "/batty?token=x",
    ]) {
      await writeStoredOptions(directory, { baseUrl });
      await expect(loadAppOptions(directory)).rejects.toThrow("Expected a URL path");
    }
  } finally {
    await fs.rm(directory, { recursive: true });
  }
});
