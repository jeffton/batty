import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { ensureOptionsFile, optionsFilePath } from "@/server/options";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createProjectRoot(): Promise<string> {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-face-options-"));
  tempDirs.push(projectRoot);
  return projectRoot;
}

describe("ensureOptionsFile", () => {
  it("creates options.json, generates authSecret, and rejects missing required options", async () => {
    const projectRoot = await createProjectRoot();

    await expect(ensureOptionsFile(projectRoot)).rejects.toThrow(
      `Missing required options in ${optionsFilePath(projectRoot)}: username, password, workspacesRoot, webPushSubject.`,
    );

    const persisted = JSON.parse(await fs.readFile(optionsFilePath(projectRoot), "utf8")) as {
      username: string;
      password: string;
      authSecret: string;
      workspacesRoot: string;
      webPushSubject: string;
    };

    expect(persisted.username).toBe("");
    expect(persisted.password).toBe("");
    expect(persisted.authSecret.length).toBeGreaterThan(0);
    expect(persisted.workspacesRoot).toBe("");
    expect(persisted.webPushSubject).toBe("");
  });

  it("preserves configured values and fills in a missing authSecret", async () => {
    const projectRoot = await createProjectRoot();

    await fs.mkdir(path.dirname(optionsFilePath(projectRoot)), { recursive: true });
    await fs.writeFile(
      optionsFilePath(projectRoot),
      `${JSON.stringify(
        {
          username: "david",
          password: "configured-password",
          workspacesRoot: "/root/github",
          webPushSubject: "https://pi.roybot.se",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const options = await ensureOptionsFile(projectRoot);

    expect(options.username).toBe("david");
    expect(options.password).toBe("configured-password");
    expect(options.workspacesRoot).toBe("/root/github");
    expect(options.webPushSubject).toBe("https://pi.roybot.se");
    expect(options.authSecret.length).toBeGreaterThan(0);
  });
});
