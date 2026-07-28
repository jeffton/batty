import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { environmentFilePath, loadConfig, resolveBattyDir } from "@/server/config";
import { optionsFilePath } from "@/server/options";

const tempDirs: string[] = [];
const envKeys = ["BATTY_HOST", "BATTY_PORT", "BATTY_SELF_PATH"] as const;
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  for (const key of envKeys) {
    const value = originalEnv.get(key);
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

async function createBattyDir(): Promise<string> {
  const battyDir = await fs.mkdtemp(path.join(os.tmpdir(), "batty-config-"));
  tempDirs.push(battyDir);
  await fs.mkdir(path.dirname(optionsFilePath(battyDir)), { recursive: true });
  await fs.writeFile(
    optionsFilePath(battyDir),
    `${JSON.stringify(
      {
        authSecret: "test-secret",
        workspacesRoots: ["/tmp/workspaces"],
        webPushSubject: "https://batty.test",
        cronDailySessionStartTime: "04:00",
        braveSearchKey: "configured-brave-key",
        defaultProvider: "openai-codex",
        defaultModel: "gpt-5.6-sol",
        defaultThinkingLevel: "medium",
        baseUrl: "/batty",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return battyDir;
}

describe("resolveBattyDir", () => {
  it("requires a batty directory argument", () => {
    expect(() => resolveBattyDir([])).toThrow(
      "Missing batty directory argument. Pass the deployment root path as argv[2].",
    );
  });

  it("resolves the provided path", () => {
    expect(resolveBattyDir(["."])).toBe(path.resolve("."));
    expect(resolveBattyDir(["~/ignored-as-literal"])).toBe(path.resolve("~/ignored-as-literal"));
    expect(resolveBattyDir([os.tmpdir()])).toBe(path.resolve(os.tmpdir()));
  });
});

describe("loadConfig", () => {
  it("loads environment variables from <batty-dir>/.batty/environment.json", async () => {
    const battyDir = await createBattyDir();
    await fs.writeFile(
      environmentFilePath(battyDir),
      `${JSON.stringify(
        {
          BATTY_HOST: "0.0.0.0",
          BATTY_PORT: "4242",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const config = await loadConfig(battyDir);

    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(4242);
    expect(config.cronDailySessionStartTime).toBe("04:00");
    expect(config.braveSearchKey).toBe("configured-brave-key");
    expect(config.defaultProvider).toBe("openai-codex");
    expect(config.defaultModel).toBe("gpt-5.6-sol");
    expect(config.defaultThinkingLevel).toBe("medium");
    expect(config.baseUrl).toBe("/batty");
  });

  it("prefers BATTY_SELF_PATH over the current working directory", async () => {
    const battyDir = await createBattyDir();
    process.env.BATTY_SELF_PATH = "/opt/batty/current";

    const config = await loadConfig(battyDir);

    expect(config.selfPath).toBe("/opt/batty/current");
    expect(config.publicDir).toBe("/opt/batty/current/dist/client");
    expect(config.sentFilesDir).toBe(path.join(battyDir, ".batty", "sent-files"));
  });
});
