import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { loadConfig } from "./config";
import { CronStore } from "./cron";
import { startDeploymentControl } from "./deployment-control";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];
const cliPath = path.resolve("src/server/cli.ts");
const tsxPath = path.resolve("node_modules/.bin/tsx");

async function createRoot(options = true): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-cli-"));
  tempDirs.push(root);
  await fs.mkdir(path.join(root, ".batty"), { recursive: true });
  await fs.mkdir(path.join(root, "batty"));
  if (options) {
    await fs.writeFile(
      path.join(root, ".batty", "options.json"),
      JSON.stringify({ workspacesRoots: [root], webPushSubject: "mailto:test@example.com" }),
    );
  }
  return root;
}

async function runCli(root: string, args: string[]): Promise<{ code: number; output: string }> {
  try {
    const result = await execFileAsync(tsxPath, [cliPath, "--root", root, ...args]);
    return { code: 0, output: `${result.stdout}${result.stderr}` };
  } catch (error) {
    const result = error as Error & { code?: number; stdout?: string; stderr?: string };
    return {
      code: result.code ?? 1,
      output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    };
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("deployment CLI", () => {
  it("drains without loading configuration", async () => {
    const root = await createRoot(false);
    let drained = false;
    const control = await startDeploymentControl(root, async () => {
      drained = true;
    });

    try {
      const drain = await runCli(root, ["drain"]);
      expect(drain).toMatchObject({ code: 0 });
      expect(drain.output).toContain("All active turns have finished.");
      expect(drained).toBe(true);
    } finally {
      await control.close();
    }
  });
});

describe("cron CLI model validation", () => {
  it("rejects an unknown model before creating a job", async () => {
    const root = await createRoot();
    const result = await runCli(root, [
      "cron",
      "add",
      "--workspace",
      "batty",
      "--prompt",
      "Inspect CI",
      "--model",
      "missing/model",
      "--thinking",
      "medium",
      "--in",
      "1h",
    ]);

    expect(result).toMatchObject({ code: 1 });
    expect(result.output).toContain("Model not found: missing/model");
    const store = new CronStore(await loadConfig(root));
    expect(await store.listJobs()).toEqual([]);
  });

  it("rejects an unknown replacement model before editing a job", async () => {
    const root = await createRoot();
    const store = new CronStore(await loadConfig(root));
    const job = await store.createJob({
      workspaceId: "batty",
      prompt: "Inspect CI",
      model: "openai/gpt-5",
      thinkingLevel: "medium",
      schedule: { kind: "every", every: "1h" },
    });

    const result = await runCli(root, ["cron", "edit", job.id, "--model", "missing/model"]);

    expect(result).toMatchObject({ code: 1 });
    expect(result.output).toContain("Model not found: missing/model");
    expect((await store.listJobs())[0]?.model).toBe("openai/gpt-5");
  });
});
