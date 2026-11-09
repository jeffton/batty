import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fastify from "fastify";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import type { AppConfig } from "../config";
import { registerWorkspaceFileRoutes } from "./workspace-files";

let root: string;
let workspace: string;
let app: ReturnType<typeof fastify>;
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
  app = fastify();
  registerWorkspaceFileRoutes(app, {
    battyDir: root,
    workspacesRoots: [path.join(root, "workspaces")],
  } as AppConfig);
});
afterEach(async () => {
  await app.close();
  await fs.rm(root, { recursive: true, force: true });
});
function get(file = "", workspaceId = "project") {
  return app.inject(`/api/workspaces/${workspaceId}/files?${new URLSearchParams({ path: file })}`);
}

test("lists one directory at a time, including hidden files, and reads UTF-8 and empty source", async () => {
  const listing = (await get()).json();
  expect(listing.kind).toBe("directory");
  expect(listing.entries[0]).toEqual({ path: "src", kind: "directory" });
  expect(listing.entries).toContainEqual({ path: ".hidden", kind: "file" });
  expect(listing.entries.some((entry: { path: string }) => entry.path === "src/main.ts")).toBe(
    false,
  );
  expect((await get("src")).json()).toEqual({
    kind: "directory",
    path: "src",
    entries: [{ path: "src/main.ts", kind: "file" }],
  });
  expect((await get("src/main.ts")).json()).toEqual({
    kind: "text",
    path: "src/main.ts",
    contents: 'export const greeting = "Hej 🦾";\n',
  });
  expect((await get("empty")).json()).toEqual({ kind: "text", path: "empty", contents: "" });
  for (const file of ["binary", "invalid-utf8"]) {
    expect((await get(file)).json()).toEqual({ kind: "binary", path: file });
  }
});

test("rejects unknown workspaces, missing files, traversal, absolute and NUL paths", async () => {
  expect((await get("", "missing")).statusCode).toBe(404);
  expect((await get("missing")).statusCode).toBe(404);
  for (const file of [
    "../outside",
    "src/../../outside",
    "/etc/passwd",
    "C:\\Windows",
    "\\\\host\\file",
    "src\\..\\private",
    "\0",
  ]) {
    expect((await get(file)).statusCode, file).toBe(400);
  }
  expect((await app.inject("/api/workspaces/project/files?path=%2e%2e%2foutside")).statusCode).toBe(
    400,
  );
});

test("allows internal symlinks and blocks external links, including prefix-lookalike roots", async () => {
  await fs.symlink(path.join(workspace, "src"), path.join(workspace, "linked"), "dir");
  await fs.symlink(path.join(root, "outside"), path.join(workspace, "outside"), "dir");
  await fs.mkdir(`${workspace}-outside`);
  await fs.writeFile(path.join(`${workspace}-outside`, "secret"), "not workspace content");
  await fs.symlink(`${workspace}-outside`, path.join(workspace, "prefix"), "dir");
  await fs.symlink(path.join(root, "outside/private.txt"), path.join(workspace, "secret"));
  expect((await get()).json().entries).toContainEqual({ path: "linked", kind: "directory" });
  expect((await get("linked/main.ts")).json().contents).toContain("Hej 🦾");
  for (const file of ["outside", "outside/private.txt", "prefix/secret", "secret"]) {
    expect((await get(file)).statusCode, file).toBe(403);
  }
});

test.runIf(process.platform !== "win32")("does not read FIFOs", async () => {
  await promisify(execFile)("mkfifo", [path.join(workspace, "pipe")]);
  expect((await get("pipe")).json()).toEqual({ kind: "unsupported", path: "pipe" });
});
