import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { workspaceGitBranch } from "./workspace-git";
import { listWorkspaces } from "./workspaces";
import type { AppConfig } from "./config";

const exec = promisify(execFile);
let root: string;
let repo: string;
const git = (...args: string[]) => exec("git", ["-C", repo, ...args]);
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-workspace-git-"));
  repo = path.join(root, "project");
  await fs.mkdir(repo);
  await git("init", "--initial-branch=feature/æøå");
  await git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "Initial",
  );
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test("reads actual branches, nested directories, linked worktrees and symlinks without caching", async () => {
  await fs.mkdir(path.join(repo, "nested"));
  expect(await workspaceGitBranch(path.join(repo, "nested"))).toBe("feature/æøå");
  const worktree = path.join(root, "linked");
  await git("worktree", "add", "-b", "other/branch", worktree);
  expect(await workspaceGitBranch(worktree)).toBe("other/branch");
  if (process.platform !== "win32") {
    const link = path.join(root, "symlink");
    await fs.symlink(repo, link, "dir");
    expect(await workspaceGitBranch(link)).toBe("feature/æøå");
  }
  const config = { battyDir: path.join(root, ".batty"), workspacesRoots: [root] } as AppConfig;
  expect(
    (await listWorkspaces(config, true)).find((workspace) => workspace.id === "project")?.gitBranch,
  ).toBe("feature/æøå");
  await git("checkout", "-b", "new/current");
  expect(
    (await listWorkspaces(config, true)).find((workspace) => workspace.id === "project")?.gitBranch,
  ).toBe("new/current");
  expect(
    (await listWorkspaces(config)).find((workspace) => workspace.id === "project"),
  ).not.toHaveProperty("gitBranch");
});

test("distinguishes detached HEAD, ordinary folders, and actual git errors", async () => {
  await git("checkout", "--detach");
  expect(await workspaceGitBranch(repo)).toBe("detached HEAD");
  const plain = path.join(root, "plain");
  await fs.mkdir(plain);
  expect(await workspaceGitBranch(plain)).toBeNull();
  await expect(workspaceGitBranch(path.join(root, "missing"))).rejects.toThrow();
  await fs.writeFile(path.join(plain, ".git"), "gitdir: /missing/batty-test-repository\n");
  await expect(workspaceGitBranch(plain)).rejects.toThrow();
});
