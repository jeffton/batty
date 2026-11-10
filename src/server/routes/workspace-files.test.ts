import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import type { AppConfig } from "../config";
import { workspaceFiles, workspaceGit, workspaceSearch } from "./workspace-files";

let root: string;
let workspace: string;
let config: AppConfig;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-workspace-files-"));
  workspace = path.join(root, "workspaces/project");
  await fs.mkdir(path.join(workspace, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "outside"));
  await fs.writeFile(path.join(root, "outside/private.txt"), "not workspace content");
  await fs.writeFile(path.join(workspace, "src/main.ts"), 'export const greeting = "Hej 🦾";\n');
  await fs.writeFile(path.join(workspace, ".hidden"), "hidden file");
  await fs.writeFile(path.join(workspace, "empty"), "");
  await fs.writeFile(path.join(workspace, "binary"), Buffer.from([0, 10, 20]));
  await fs.writeFile(path.join(workspace, "invalid-utf8"), Buffer.from([0xff, 0xfe]));
  config = {
    battyDir: root,
    workspacesRoots: [path.join(root, "workspaces")],
  } as AppConfig;
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
function get(file = "", workspaceId = "project") {
  return workspaceFiles(config, workspaceId, file);
}

test("exports direct workspace operations for native RPC", async () => {
  const config = {
    battyDir: root,
    workspacesRoots: [path.join(root, "workspaces")],
  } as AppConfig;
  expect(await workspaceGit(config, "project")).toEqual({ branch: null });
  expect(await workspaceFiles(config, "project", "src/main.ts")).toEqual({
    kind: "text",
    path: "src/main.ts",
    contents: 'export const greeting = "Hej 🦾";\n',
  });
  const matches: string[] = [];
  for await (const match of workspaceSearch(
    config,
    "project",
    "main",
    new AbortController().signal,
  ))
    matches.push(match);
  expect(matches).toEqual(["src/main.ts"]);
  await expect(workspaceGit(config, "missing")).rejects.toMatchObject({ statusCode: 404 });
});

test("reads fresh workspace git state and rejects unknown IDs", async () => {
  expect(await workspaceGit(config, "project")).toEqual({ branch: null });
  await expect(workspaceGit(config, "unknown")).rejects.toMatchObject({ statusCode: 404 });
  await promisify(execFile)("git", ["-C", workspace, "init", "--initial-branch=feature/actual"]);
  expect(await workspaceGit(config, "project")).toEqual({
    branch: "feature/actual",
  });
  await promisify(execFile)("git", [
    "-C",
    workspace,
    "symbolic-ref",
    "HEAD",
    "refs/heads/switched",
  ]);
  expect(await workspaceGit(config, "project")).toEqual({ branch: "switched" });
});

test("lists one directory at a time, including hidden files, and reads UTF-8 and empty source", async () => {
  const listing = await get();
  if (listing.kind !== "directory") throw new Error("Expected directory");
  expect(listing.kind).toBe("directory");
  expect(listing.entries[0]).toEqual({ path: "src", kind: "directory" });
  expect(listing.entries).toContainEqual({ path: ".hidden", kind: "file" });
  expect(listing.entries.some((entry: { path: string }) => entry.path === "src/main.ts")).toBe(
    false,
  );
  expect(await get("src")).toEqual({
    kind: "directory",
    path: "src",
    entries: [{ path: "src/main.ts", kind: "file" }],
  });
  expect(await get("src/main.ts")).toEqual({
    kind: "text",
    path: "src/main.ts",
    contents: 'export const greeting = "Hej 🦾";\n',
  });
  expect(await get("empty")).toEqual({ kind: "text", path: "empty", contents: "" });
  for (const file of ["binary", "invalid-utf8"]) {
    expect(await get(file)).toEqual({ kind: "binary", path: file });
  }
});

test("rejects unknown workspaces, missing files, traversal, absolute and NUL paths", async () => {
  await expect(get("", "missing")).rejects.toMatchObject({ statusCode: 404 });
  await expect(
    workspaceSearch(config, "missing", "x", new AbortController().signal).next(),
  ).rejects.toMatchObject({ statusCode: 404 });
  await expect(
    workspaceSearch(config, "project", "", new AbortController().signal).next(),
  ).rejects.toMatchObject({ statusCode: 400 });
  await expect(get("missing")).rejects.toMatchObject({ statusCode: 404 });
  for (const file of [
    "../outside",
    "src/../../outside",
    "/etc/passwd",
    "C:\\Windows",
    "\\\\host\\file",
    "src\\..\\private",
    "\0",
  ]) {
    await expect(get(file)).rejects.toMatchObject({ statusCode: 400 });
  }
});

test("allows internal symlinks and blocks external links, including prefix-lookalike roots", async () => {
  await fs.symlink(path.join(workspace, "src"), path.join(workspace, "linked"), "dir");
  await fs.symlink(path.join(root, "outside"), path.join(workspace, "outside"), "dir");
  await fs.mkdir(`${workspace}-outside`);
  await fs.writeFile(path.join(`${workspace}-outside`, "secret"), "not workspace content");
  await fs.symlink(`${workspace}-outside`, path.join(workspace, "prefix"), "dir");
  await fs.symlink(path.join(root, "outside/private.txt"), path.join(workspace, "secret"));
  expect(
    ((await get()) as Extract<Awaited<ReturnType<typeof get>>, { kind: "directory" }>).entries,
  ).toContainEqual({ path: "linked", kind: "directory" });
  expect(((await get("linked/main.ts")) as { contents: string }).contents).toContain("Hej 🦾");
  for (const file of ["outside", "outside/private.txt", "prefix/secret", "secret"]) {
    await expect(get(file)).rejects.toMatchObject({ statusCode: 403 });
  }
});

test.runIf(process.platform !== "win32")("does not read FIFOs", async () => {
  await promisify(execFile)("mkfifo", [path.join(workspace, "pipe")]);
  expect(await get("pipe")).toEqual({ kind: "unsupported", path: "pipe" });
});
