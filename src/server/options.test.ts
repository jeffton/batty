import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_USERNAME,
  DEFAULT_WEB_PUSH_SUBJECT,
  ensureOptionsFile,
  optionsFilePath,
} from "@/server/options";

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
  it("creates .pi-face/options.json with persisted defaults and a generated secret", async () => {
    const projectRoot = await createProjectRoot();

    const options = await ensureOptionsFile(projectRoot);
    const persisted = JSON.parse(await fs.readFile(optionsFilePath(projectRoot), "utf8")) as {
      username: string;
      authSecret: string;
      workspacesRoot: string;
      webPushSubject: string;
    };

    expect(options.password).toBeUndefined();
    expect(persisted.username).toBe(DEFAULT_USERNAME);
    expect(persisted.authSecret.length).toBeGreaterThan(0);
    expect(persisted.workspacesRoot).toBe(path.join(os.homedir(), "github"));
    expect(persisted.webPushSubject).toBe(DEFAULT_WEB_PUSH_SUBJECT);
  });

  it("preserves configured credentials while filling missing fields", async () => {
    const projectRoot = await createProjectRoot();
    const configuredPassword = crypto.randomUUID();

    await fs.mkdir(path.dirname(optionsFilePath(projectRoot)), { recursive: true });
    await fs.writeFile(
      optionsFilePath(projectRoot),
      `${JSON.stringify({ username: "david", password: configuredPassword }, null, 2)}\n`,
      "utf8",
    );

    const options = await ensureOptionsFile(projectRoot);

    expect(options.username).toBe("david");
    expect(options.password).toBe(configuredPassword);
    expect(options.authSecret.length).toBeGreaterThan(0);
    expect(options.webPushSubject).toBe(DEFAULT_WEB_PUSH_SUBJECT);
  });
});
