import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { ensureOptionsFile, optionsFilePath } from "@/server/options";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createBattyDir(): Promise<string> {
  const battyDir = await fs.mkdtemp(path.join(os.tmpdir(), "batty-root-"));
  tempDirs.push(battyDir);
  return battyDir;
}

describe("ensureOptionsFile", () => {
  it("creates options.json inside <batty-dir>/.batty and rejects missing required options", async () => {
    const battyDir = await createBattyDir();

    await expect(ensureOptionsFile(battyDir)).rejects.toThrow(
      `Missing required options in ${optionsFilePath(battyDir)}: username, password, workspacesRoot, webPushSubject.`,
    );

    const persisted = JSON.parse(await fs.readFile(optionsFilePath(battyDir), "utf8")) as {
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
    const battyDir = await createBattyDir();

    await fs.mkdir(path.dirname(optionsFilePath(battyDir)), { recursive: true });
    await fs.writeFile(
      optionsFilePath(battyDir),
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

    const options = await ensureOptionsFile(battyDir);

    expect(options.username).toBe("david");
    expect(options.password).toBe("configured-password");
    expect(options.workspacesRoot).toBe("/root/github");
    expect(options.webPushSubject).toBe("https://pi.roybot.se");
    expect(options.authSecret.length).toBeGreaterThan(0);
  });
});
