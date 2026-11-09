import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fastify, { type FastifyInstance } from "fastify";
import type { WorkspaceFileSearchEvent } from "@/shared/workspace-files";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { AppConfig } from "./config";
import { searchWorkspaceFileNames } from "./workspace-file-search";
import { registerWorkspaceFileRoutes } from "./routes/workspace-files";

let root: string;
let workspace: string;
let app: FastifyInstance;
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
  app = fastify();
  registerWorkspaceFileRoutes(app, {
    battyDir: root,
    workspacesRoots: [path.join(root, "workspaces")],
  } as AppConfig);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
  await fs.rm(root, { recursive: true, force: true });
});
async function search(name: string, workspaceId = "project") {
  const response = await app.inject(
    `/api/workspaces/${workspaceId}/file-search?${new URLSearchParams({ name })}`,
  );
  return {
    response,
    events:
      response.statusCode === 200
        ? response.body
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as WorkspaceFileSearchEvent)
        : [],
  };
}
test("searches case-insensitive basenames in unopened and hidden folders, never directory names or contents", async () => {
  const result = await search("rEAd");
  expect(result.response.headers["content-type"]).toContain("application/x-ndjson");
  expect(
    result.events
      .filter((event) => event.kind === "match")
      .map((event) => event.path)
      .sort(),
  ).toEqual([".git/objects/READme.txt", "Readme.md"]);
  expect(result.events.at(-1)).toEqual({ kind: "done" });
  expect((await search("ångström")).events[0]).toEqual({ kind: "match", path: "ÅNGSTRÖM.ts" });
  expect((await search("read-folder")).events).toEqual([{ kind: "done" }]);
  expect((await search("content")).events).toEqual([{ kind: "done" }]);
  await fs.writeFile(path.join(workspace, "new-read.ts"), "");
  expect((await search("new-read")).events[0]).toEqual({ kind: "match", path: "new-read.ts" });
  await fs.unlink(path.join(workspace, "new-read.ts"));
  expect((await search("new-read")).events).toEqual([{ kind: "done" }]);
  expect((await search("../")).events).toEqual([{ kind: "done" }]);
  expect((await search("")).response.statusCode).toBe(400);
  expect((await search("read", "unknown")).response.statusCode).toBe(404);
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
  const result = (await search(".ts")).events;
  expect(
    result
      .filter((event) => event.kind === "match")
      .map((event) => event.path)
      .sort(),
  ).toEqual(["alias.ts", "read-folder/deep/other.ts", "ÅNGSTRÖM.ts"]);
  expect(result.at(-1)).toEqual({ kind: "done" });
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
  const result = await search("read");
  expect(result.events.at(-1)).toEqual({
    kind: "error",
    message: "Permission denied searching .git",
  });
  expect(result.events.some((event) => event.kind === "done")).toBe(false);
});

test("disconnecting an HTTP search cancels recursive filesystem work", async () => {
  for (let index = 0; index < 250; index++) {
    const directory = path.join(workspace, `nested-${index}`);
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, "needle.ts"), "");
  }
  await fs.writeFile(path.join(workspace, "needle-root.ts"), "");
  const opened = vi.spyOn(fs, "opendir");
  let closed!: () => void;
  const disconnected = new Promise<void>((resolve) => {
    closed = resolve;
  });
  app.addHook("onRequest", async (_request, reply) => {
    reply.raw.once("close", closed);
  });
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  const response = await fetch(`${origin}/api/workspaces/project/file-search?name=needle`);
  const reader = response.body!.getReader();
  expect((await reader.read()).done).toBe(false);
  await reader.cancel();
  await disconnected;
  // The response's close signal arrives while the walk still has unopened directories.
  expect(opened.mock.calls.length).toBeLessThan(250);
});
