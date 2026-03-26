import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
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
    authSecret: crypto.randomUUID(),
  };
}

async function createSession(workspacePath: string, updatedAt: Date): Promise<void> {
  const session = SessionManager.create(workspacePath);
  const sessionFile = session.getSessionFile();
  if (!sessionFile) {
    throw new Error("Expected persisted session file");
  }

  const sessionId = path.basename(sessionFile, ".jsonl");
  const header = {
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: updatedAt.toISOString(),
    cwd: workspacePath,
  };
  const message = {
    type: "message",
    id: `${sessionId}-message-1`,
    timestamp: updatedAt.toISOString(),
    message: {
      role: "user",
      content: `Session for ${path.basename(workspacePath)}`,
    },
  };

  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.writeFile(sessionFile, `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`);
  await fs.utimes(sessionFile, updatedAt, updatedAt);
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

  it("orders workspaces by most recent session before alphabetical fallback", async () => {
    const config = await createConfig();
    const alphaPath = path.join(config.workspacesRoot, "alpha");
    const betaPath = path.join(config.workspacesRoot, "beta");
    const gammaPath = path.join(config.workspacesRoot, "gamma");

    await fs.mkdir(alphaPath);
    await fs.mkdir(betaPath);
    await fs.mkdir(gammaPath);
    await createSession(betaPath, new Date("2026-03-25T12:00:00Z"));
    await createSession(alphaPath, new Date("2026-03-24T12:00:00Z"));

    const workspaces = await listWorkspaces(config);

    expect(workspaces.map((workspace) => workspace.label)).toEqual(["beta", "alpha", "gamma"]);
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
