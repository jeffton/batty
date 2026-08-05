import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { AppConfig } from "@/server/config";
import { optionsFilePath } from "@/server/options";
import { createWorkspace, listWorkspaces } from "@/server/workspaces";

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
    workspacesRoots: [root],
    selfPath: path.join(root, "self-project"),
    battyDir: root,
    uploadsDir: path.join(root, "uploads"),
    sentFilesDir: path.join(root, "sent-files"),
    publicDir: path.join(root, "public"),
    webPushDir: path.join(root, "web-push"),
    webPushSubject: "mailto:test@example.com",
    cronDailySessionStartTime: "04:00",
    baseUrl: "/",
    appTitle: "Batty",
    appColor: "neutral",
    cookieName: "test",
    authSecret: crypto.randomUUID(),
  };
}

describe("workspaces", () => {
  it("includes discovered visible child folders", async () => {
    const config = await createConfig();
    await fs.mkdir(path.join(config.workspacesRoots[0]!, "alpha"));
    await fs.mkdir(path.join(config.workspacesRoots[0]!, "beta"));
    await fs.mkdir(path.join(config.workspacesRoots[0]!, ".batty"));

    const workspaces = await listWorkspaces(config);

    expect(workspaces.map((workspace) => workspace.label)).toEqual(["alpha", "beta"]);
  });

  it("orders pinned workspaces first and then alphabetically", async () => {
    const config = await createConfig();

    await fs.mkdir(path.join(config.workspacesRoots[0]!, "alpha"));
    await fs.mkdir(path.join(config.workspacesRoots[0]!, "beta"));
    await fs.mkdir(path.join(config.workspacesRoots[0]!, "gamma"));
    await fs.mkdir(path.dirname(optionsFilePath(config.battyDir)), { recursive: true });
    await fs.writeFile(
      optionsFilePath(config.battyDir),
      `${JSON.stringify(
        {
          authSecret: config.authSecret,
          workspacesRoots: [config.workspacesRoots[0]!],
          webPushSubject: config.webPushSubject,
          cronDailySessionStartTime: config.cronDailySessionStartTime,
          pinnedWorkspaceIds: ["gamma", "beta"],
          assistantWorkspaceId: "beta",
        },
        null,
        2,
      )}\n`,
    );

    const workspaces = await listWorkspaces(config);

    expect(workspaces.map((workspace) => workspace.label)).toEqual(["beta", "gamma", "alpha"]);
    expect(workspaces.map((workspace) => workspace.isPinned)).toEqual([true, true, false]);
    expect(workspaces.map((workspace) => workspace.isAssistant)).toEqual([true, false, false]);
  });

  it("uses folder names as workspace ids", async () => {
    const config = await createConfig();
    await fs.mkdir(path.join(config.workspacesRoots[0]!, "my workspace"));

    const workspaces = await listWorkspaces(config);

    expect(workspaces.find((workspace) => workspace.label === "my workspace")?.id).toBe(
      "my workspace",
    );
  });

  it("creates a workspace directly under the configured root", async () => {
    const config = await createConfig();

    const workspace = await createWorkspace(config, "alpha");
    const stats = await fs.stat(path.join(config.workspacesRoots[0]!, "alpha"));

    expect(workspace).toEqual({
      id: "alpha",
      label: "alpha",
      path: path.join(config.workspacesRoots[0]!, "alpha"),
      kind: "workspace",
      isPinned: false,
      isAssistant: false,
    });
    expect(stats.isDirectory()).toBe(true);
  });

  it("lists and creates workspaces across multiple configured roots sorted by workspace name", async () => {
    const config = await createConfig();
    const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), "batty-workspaces-extra-"));
    tempDirs.push(secondRoot);
    config.workspacesRoots = [config.workspacesRoots[0]!, secondRoot];

    await fs.mkdir(path.join(config.workspacesRoots[0]!, "zeta"));
    await fs.mkdir(path.join(secondRoot, "alpha"));
    await fs.mkdir(path.join(config.workspacesRoots[0]!, "beta"));

    const created = await createWorkspace(config, "aardvark", secondRoot);
    const workspaces = await listWorkspaces(config);

    expect(workspaces.map((workspace) => workspace.label)).toEqual([
      "aardvark",
      "alpha",
      "beta",
      "zeta",
    ]);
    expect(workspaces.every((workspace) => workspace.rootPath)).toBe(true);
    expect(workspaces.find((workspace) => workspace.label === "alpha")?.rootPath).toBe(secondRoot);
    const stats = await fs.stat(path.join(secondRoot, "aardvark"));
    expect(created.rootPath).toBe(secondRoot);
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
