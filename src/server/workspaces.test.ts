import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { listWorkspaces } from "@/server/workspaces";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("listWorkspaces", () => {
  it("includes pi-face itself and discovered child folders", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-face-workspaces-"));
    tempDirs.push(root);
    await fs.mkdir(path.join(root, "alpha"));
    await fs.mkdir(path.join(root, "beta"));

    const workspaces = await listWorkspaces({
      host: "127.0.0.1",
      port: 3147,
      workspacesRoot: root,
      selfPath: path.join(root, "self-project"),
      uploadsDir: path.join(root, "uploads"),
      publicDir: path.join(root, "public"),
      cookieName: "test",
      authPassword: "secret",
      authSecret: "secret",
    });

    expect(workspaces[0]?.id).toBe("pi-face");
    expect(workspaces.map((workspace) => workspace.label)).toEqual(["pi-face", "alpha", "beta"]);
  });
});
