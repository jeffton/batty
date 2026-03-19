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
      `Missing required options in ${optionsFilePath(battyDir)}: workspacesRoot, webPushSubject.`,
    );

    const persisted = JSON.parse(await fs.readFile(optionsFilePath(battyDir), "utf8")) as {
      authSecret: string;
      workspacesRoot: string;
      webPushSubject: string;
    };

    expect(persisted.authSecret.length).toBeGreaterThan(0);
    expect(persisted.workspacesRoot).toBe("");
    expect(persisted.webPushSubject).toBe("");
  });

  it("drops legacy password auth fields and preserves the rest", async () => {
    const battyDir = await createBattyDir();

    await fs.mkdir(path.dirname(optionsFilePath(battyDir)), { recursive: true });
    await fs.writeFile(
      optionsFilePath(battyDir),
      `${JSON.stringify(
        {
          username: "david",
          password: "configured-password",
          authSecret: "existing-secret",
          workspacesRoot: "/root/github",
          webPushSubject: "https://batty.roybot.se",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const options = await ensureOptionsFile(battyDir);
    const persisted = JSON.parse(await fs.readFile(optionsFilePath(battyDir), "utf8")) as Record<
      string,
      unknown
    >;

    expect(options.authSecret).toBe("existing-secret");
    expect(options.workspacesRoot).toBe("/root/github");
    expect(options.webPushSubject).toBe("https://batty.roybot.se");
    expect(persisted.username).toBeUndefined();
    expect(persisted.password).toBeUndefined();
  });
});
