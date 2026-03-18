import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { ensureOptionsFile, optionsFilePath } from "@/server/options";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createPiFaceDir(): Promise<string> {
  const piFaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-face-root-"));
  tempDirs.push(piFaceDir);
  return piFaceDir;
}

describe("ensureOptionsFile", () => {
  it("creates options.json inside <pi-face-dir>/.pi-face and rejects missing required options", async () => {
    const piFaceDir = await createPiFaceDir();

    await expect(ensureOptionsFile(piFaceDir)).rejects.toThrow(
      `Missing required options in ${optionsFilePath(piFaceDir)}: username, password, workspacesRoot, webPushSubject.`,
    );

    const persisted = JSON.parse(await fs.readFile(optionsFilePath(piFaceDir), "utf8")) as {
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
    const piFaceDir = await createPiFaceDir();

    await fs.mkdir(path.dirname(optionsFilePath(piFaceDir)), { recursive: true });
    await fs.writeFile(
      optionsFilePath(piFaceDir),
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

    const options = await ensureOptionsFile(piFaceDir);

    expect(options.username).toBe("david");
    expect(options.password).toBe("configured-password");
    expect(options.workspacesRoot).toBe("/root/github");
    expect(options.webPushSubject).toBe("https://pi.roybot.se");
    expect(options.authSecret.length).toBeGreaterThan(0);
  });
});
