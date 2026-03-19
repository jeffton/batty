import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createWorkspace, listWorkspaces } from "@/server/workspaces";
import type { AppConfig } from "@/server/config";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createConfig(): Promise<AppConfig> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-workspaces-"));
  tempDirs.push(root);

  return {
    host: "127.0.0.1",
    port: 3147,
    workspacesRoot: root,
    selfPath: path.join(root, "self-project"),
    uploadsDir: path.join(root, "uploads"),
    publicDir: path.join(root, "public"),
    webPushDir: path.join(root, "web-push"),
    webPushSubject: "mailto:test@example.com",
    cookieName: "test",
    username: "test-user",
    password: crypto.randomUUID(),
    authSecret: crypto.randomUUID(),
  };
}

describe("workspaces", () => {
  it("includes discovered visible child folders", async () => {
    const config = await createConfig();
    await fs.mkdir(path.join(config.workspacesRoot, "alpha"));
    await fs.mkdir(path.join(config.workspacesRoot, "beta"));
    await fs.mkdir(path.join(config.workspacesRoot, ".batty"));

    const workspaces = await listWorkspaces(config);

    expect(workspaces.map((workspace) => workspace.label)).toEqual(["alpha", "beta"]);
  });

  it("uses folder names as workspace ids", async () => {
    const config = await createConfig();
    await fs.mkdir(path.join(config.workspacesRoot, "my workspace"));

    const workspaces = await listWorkspaces(config);

    expect(workspaces.find((workspace) => workspace.label === "my workspace")?.id).toBe(
      "my workspace",
    );
  });

  it("creates a workspace directly under the configured root", async () => {
    const config = await createConfig();

    const workspace = await createWorkspace(config, "alpha");
    const stats = await fs.stat(path.join(config.workspacesRoot, "alpha"));

    expect(workspace).toEqual({
      id: "alpha",
      label: "alpha",
      path: path.join(config.workspacesRoot, "alpha"),
      kind: "workspace",
    });
    expect(stats.isDirectory()).toBe(true);
  });

  it("rejects nested paths, path traversal, and hidden folders", async () => {
    const config = await createConfig();

    await expect(createWorkspace(config, "nested/child")).rejects.toMatchObject({
      message: "Workspace name cannot contain path separators",
      statusCode: 400,
    });

    await expect(createWorkspace(config, "../escape")).rejects.toMatchObject({
      message: "Workspace name cannot start with a dot",
      statusCode: 400,
    });

    await expect(createWorkspace(config, ".hidden")).rejects.toMatchObject({
      message: "Workspace name cannot start with a dot",
      statusCode: 400,
    });
  });
});
