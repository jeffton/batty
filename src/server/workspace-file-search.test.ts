import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { AppConfig } from "./config";
import { searchWorkspaceFileNames } from "./workspace-file-search";
import { workspaceSearch } from "./routes/workspace-files";

let root: string;
let workspace: string;
let config: AppConfig;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-file-search-"));
  workspace = path.join(root, "workspaces/project");
  await fs.mkdir(path.join(workspace, "read-folder/deep"), { recursive: true });
  await fs.mkdir(path.join(workspace, ".git/objects"), { recursive: true });
  await fs.writeFile(
    path.join(workspace, "read-folder/deep/other.ts"),
    "Read content is not searchable",
  );
  await fs.writeFile(path.join(workspace, ".git/objects/READme.txt"), "hidden tree");
  await fs.writeFile(path.join(workspace, "Readme.md"), "root");
  await fs.writeFile(path.join(workspace, "ÅNGSTRÖM.ts"), "Unicode");
  config = {
    battyDir: root,
    workspacesRoots: [path.join(root, "workspaces")],
  } as AppConfig;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
async function search(name: string, workspaceId = "project") {
  return Array.fromAsync(workspaceSearch(config, workspaceId, name, new AbortController().signal));
}

test("searches case-insensitive basenames in unopened and hidden folders, never directory names or contents", async () => {
  const result = await search("rEAd");
  expect(result.sort()).toEqual([".git/objects/READme.txt", "Readme.md"]);
  expect(await search("ångström")).toEqual(["ÅNGSTRÖM.ts"]);
  expect(await search("read-folder")).toEqual([]);
  expect(await search("content")).toEqual([]);
  await fs.writeFile(path.join(workspace, "new-read.ts"), "");
  expect(await search("new-read")).toEqual(["new-read.ts"]);
  await fs.unlink(path.join(workspace, "new-read.ts"));
  expect(await search("new-read")).toEqual([]);
  expect(await search("../")).toEqual([]);
  await expect(search("")).rejects.toMatchObject({ statusCode: 400 });
  await expect(search("read", "unknown")).rejects.toMatchObject({ statusCode: 404 });
});

test("deduplicates directory aliases and cycles, includes internal file aliases, and never follows external links", async () => {
  await fs.mkdir(path.join(root, "outside"));
  await fs.writeFile(path.join(root, "outside/secret.ts"), "");
  await fs.symlink(workspace, path.join(workspace, "read-folder/back"), "dir");
  await fs.symlink(path.join(workspace, "read-folder"), path.join(workspace, "alias-dir"), "dir");
  await fs.symlink(path.join(root, "outside"), path.join(workspace, "external"), "dir");
  await fs.symlink(path.join(root, "outside/secret.ts"), path.join(workspace, "secret.ts"));
  await fs.symlink(
    path.join(workspace, "read-folder/deep/other.ts"),
    path.join(workspace, "alias.ts"),
  );
  await fs.symlink(path.join(root, "missing"), path.join(workspace, "broken"));
  expect((await search(".ts")).sort()).toEqual([
    "alias.ts",
    "read-folder/deep/other.ts",
    "ÅNGSTRÖM.ts",
  ]);
});

test("stops a walk on cancellation and closes its directory iterator", async () => {
  const controller = new AbortController();
  const iterator = searchWorkspaceFileNames(workspace, "read", controller.signal);
  expect((await iterator.next()).done).toBe(false);
  controller.abort();
  await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
});

test("reports filesystem errors explicitly instead of successful incomplete search results", async () => {
  const original = fs.opendir;
  vi.spyOn(fs, "opendir").mockImplementation(async (...args) => {
    if (String(args[0]).endsWith(`${path.sep}.git`))
      throw Object.assign(new Error("Permission denied searching .git"), { code: "EACCES" });
    return original(...args);
  });
  await expect(search("read")).rejects.toThrow("Permission denied searching .git");
});
